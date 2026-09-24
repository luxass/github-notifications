package dsl

import (
	"strings"
	"testing"
	"time"
)

func TestParseValidateAndEvaluate(t *testing.T) {
	expression, err := Parse(`notification.reason == "review_requested" and (subject.reviewPending == false or notification.unread == true)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}

	environment := Environment{
		Notification: NotificationFields{Reason: "mention", Unread: false, UpdatedAt: time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)},
	}
	result, err := Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != False {
		t.Fatalf("unrelated notification should rule out subject lookup, got %v", result)
	}

	environment.Notification.Reason = "review_requested"
	environment.Notification.Unread = true
	result, err = Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("true notification-only branch should not need subject data, got %v", result)
	}

	environment.Notification.Unread = false
	result, err = Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != Unknown {
		t.Fatalf("subject-dependent candidate should be unknown, got %v", result)
	}

	environment.Subject.ReviewPending = false
	result, err = Evaluate(expression, environment, true)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("subject details should resolve candidate to true, got %v", result)
	}
}

func TestOperatorPrecedenceAndNot(t *testing.T) {
	expression, err := Parse(`not notification.unread or notification.reason == "mention" and repo.private == false`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}
	result, err := Evaluate(expression, Environment{
		Notification: NotificationFields{Reason: "mention", Unread: false},
		Repo:         RepositoryFields{Private: true},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("expected and to bind more tightly than or, got %v", result)
	}
}

func TestValidationRejectsUnknownAndIllTypedExpressions(t *testing.T) {
	for _, source := range []string{
		`banana.reason == "mention"`,
		`notification.title`,
		`repo.stars == 4`,
		`ctx.login == "octocat"`,
		`"mention" == notification.reason`,
		`notification.updatedAt > "not-a-date"`,
	} {
		expression, err := Parse(source)
		if err != nil {
			t.Fatalf("Parse(%q): %v", source, err)
		}
		if err := Validate(expression); err == nil {
			t.Errorf("Validate(%q) succeeded, expected error", source)
		}
	}
}

func TestParseRejectsMalformedExpressions(t *testing.T) {
	for _, source := range []string{"", "a ==", "a == 1 == 2", "a in b", "(a == 1", `"unterminated`} {
		if _, err := Parse(source); err == nil {
			t.Errorf("Parse(%q) succeeded, expected error", source)
		}
	}
}

func TestMultilineRulesAndEscapes(t *testing.T) {
	expression, err := Parse(strings.Join([]string{
		`notification.title contains "Run \"failed\""`,
		`and notification.unread == true`,
	}, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}
}
