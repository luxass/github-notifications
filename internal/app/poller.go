package app

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/luxass/github-notifications/internal/dsl"
	"github.com/luxass/github-notifications/internal/github"
	"github.com/robfig/cron/v3"
)

type compiledRule struct {
	name    string
	expr    dsl.Expression
	actions []ActionConfig
	stop    bool
}

type Poller struct {
	client       *github.Client
	maxPages     int
	rules        []compiledRule
	executor     *RuleExecutor
	schedule     cron.Schedule
	lastModified string
	logger       *slog.Logger
}

type RuleExecutor struct {
	client *github.Client
	logger *slog.Logger
}

func NewPoller(config Config, client *github.Client, logger *slog.Logger) (*Poller, error) {
	if logger == nil {
		logger = slog.Default()
	}

	rules := make([]compiledRule, 0, len(config.Rules))
	for _, definition := range config.Rules {
		expression, err := dsl.Parse(definition.When)
		if err != nil {
			return nil, fmt.Errorf("compile rule %q: %w", definition.Name, err)
		}
		if err := dsl.Validate(expression); err != nil {
			return nil, fmt.Errorf("compile rule %q: %w", definition.Name, err)
		}
		rules = append(rules, compiledRule{
			name: definition.Name, expr: expression, actions: definition.Actions, stop: definition.Stop,
		})
	}
	schedule, err := parseSchedule(config.Server.Schedule)
	if err != nil {
		return nil, fmt.Errorf("parse polling schedule: %w", err)
	}
	return &Poller{
		client: client, maxPages: config.GitHub.MaxPages, rules: rules,
		executor: &RuleExecutor{client: client, logger: logger}, schedule: schedule, logger: logger,
	}, nil
}

func (poller *Poller) Run(ctx context.Context) {
	nextScheduled := time.Now()
	nextAllowed := time.Time{}
	for {
		wakeAt := nextScheduled
		if nextAllowed.After(wakeAt) {
			wakeAt = nextAllowed
		}
		if wait := time.Until(wakeAt); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
		if ctx.Err() != nil {
			return
		}

		startedAt := time.Now()
		interval, err := poller.Poll(ctx, "schedule")
		if err != nil {
			poller.logger.Error("GitHub poll failed", "error", err)
		}
		if interval <= 0 {
			interval = 65 * time.Second
		}
		nextAllowed = time.Now().Add(interval)
		nextScheduled = poller.schedule.Next(startedAt)
	}
}

func (poller *Poller) Poll(ctx context.Context, trigger string) (time.Duration, error) {
	poller.logger.Info("Polling GitHub", "trigger", trigger)
	startedAt := time.Now()
	result, err := poller.client.ListNotifications(ctx, poller.lastModified, poller.maxPages)
	if err != nil {
		return result.PollAfter, err
	}
	if result.NotModified {
		poller.logger.Info("No new notifications", "trigger", trigger)
		return result.PollAfter, nil
	}

	matchedRules := 0
	unread := 0
	for _, notification := range result.Notifications {
		if notification.Unread {
			unread++
		}
		matched, err := poller.processNotification(ctx, notification)
		if err != nil {
			return result.PollAfter, err
		}
		matchedRules += matched
	}
	if !result.Truncated && result.LastModified != "" {
		poller.lastModified = result.LastModified
	}
	poller.logger.Info("Poll complete",
		"trigger", trigger,
		"notifications", len(result.Notifications),
		"unread", unread,
		"matchedRules", matchedRules,
		"truncated", result.Truncated,
		"durationMs", time.Since(startedAt).Milliseconds(),
	)
	return result.PollAfter, nil
}

func (poller *Poller) processNotification(ctx context.Context, notification github.Notification) (int, error) {
	environment := baseEnvironment(notification)
	subjectLoaded := false
	subjectAttempted := false
	matched := 0

	for _, rule := range poller.rules {
		result, err := dsl.Evaluate(rule.expr, environment, subjectLoaded)
		if err != nil {
			return matched, fmt.Errorf("evaluate rule %q for thread %s: %w", rule.name, notification.ID, err)
		}
		if result == dsl.Unknown && !subjectAttempted {
			environment, subjectLoaded = poller.loadSubject(ctx, notification)
			subjectAttempted = true
			if subjectLoaded {
				result, err = dsl.Evaluate(rule.expr, environment, true)
				if err != nil {
					return matched, fmt.Errorf("evaluate rule %q for thread %s: %w", rule.name, notification.ID, err)
				}
			}
		}
		if result != dsl.True {
			continue
		}

		matched++
		poller.logger.Info("Rules matched", "thread", notification.ID, "rule", rule.name)
		for _, action := range rule.actions {
			if err := poller.executor.Execute(ctx, action, environment); err != nil {
				return matched, fmt.Errorf("execute action %q for rule %q: %w", action.Type, rule.name, err)
			}
		}
		if rule.stop {
			break
		}
	}
	return matched, nil
}

func (poller *Poller) loadSubject(ctx context.Context, notification github.Notification) (dsl.Environment, bool) {
	environment := baseEnvironment(notification)
	if notification.Subject.URL == nil || (notification.Subject.Type != "Issue" && notification.Subject.Type != "PullRequest") {
		return environment, false
	}
	details, err := poller.client.GetSubject(ctx, *notification.Subject.URL)
	if err != nil {
		poller.logger.Warn("Could not fetch notification subject", "thread", notification.ID, "error", err)
		return environment, false
	}
	if details == nil {
		return environment, false
	}
	return withSubject(environment, dsl.SubjectFields{
		State: details.State, Merged: details.Merged, Author: details.Author,
		AuthorType: details.AuthorType, ReviewPending: details.ReviewPending,
	}), true
}

func baseEnvironment(notification github.Notification) dsl.Environment {
	parts := strings.SplitN(notification.Repository.FullName, "/", 2)
	owner, name := "unknown", "unknown"
	if len(parts) == 2 {
		owner, name = parts[0], parts[1]
	}
	return dsl.Environment{
		Notification: dsl.NotificationFields{
			ID: notification.ID, Reason: notification.Reason, Unread: notification.Unread,
			Title: notification.Subject.Title, Type: notification.Subject.Type, UpdatedAt: notification.UpdatedAt,
		},
		Repo:    dsl.RepositoryFields{Name: name, Owner: owner, FullName: notification.Repository.FullName, Private: notification.Repository.Private},
		Author:  dsl.AuthorFields{Login: "unknown", Type: "unknown"},
		Subject: defaultSubject(),
	}
}

func withSubject(environment dsl.Environment, subject dsl.SubjectFields) dsl.Environment {
	environment.Subject = subject
	environment.Author.Login = subject.Author
	environment.Author.Type = subject.AuthorType
	return environment
}

func defaultSubject() dsl.SubjectFields {
	return dsl.SubjectFields{State: "unknown", Author: "unknown"}
}

func (executor *RuleExecutor) Execute(ctx context.Context, action ActionConfig, environment dsl.Environment) error {
	executor.logger.Info("Executing rule action", "action", action.Type, "thread", environment.Notification.ID)
	switch action.Type {
	case "read":
		return executor.client.MarkThreadRead(ctx, environment.Notification.ID)
	case "done":
		return executor.client.MarkThreadDone(ctx, environment.Notification.ID)
	case "unsubscribe":
		return executor.client.DeleteThreadSubscription(ctx, environment.Notification.ID)
	case "unread":
		executor.logger.Warn("Skipping unread action: GitHub has no mark-unread endpoint", "thread", environment.Notification.ID)
		return nil
	default:
		return fmt.Errorf("unknown action %q", action.Type)
	}
}
