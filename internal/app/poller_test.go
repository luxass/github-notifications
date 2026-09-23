package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/luxass/github-notifications/internal/github"
)

func TestLazySubjectFetching(t *testing.T) {
	const subjectPath = "/repos/a/b/pulls/1"
	var subjectFetches, doneMutations int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case subjectPath:
			subjectFetches++
			if _, err := fmt.Fprint(writer, `{"state":"open","user":{"login":"octocat"},"requested_reviewers":[]}`); err != nil {
				t.Error(err)
			}
		case "/notifications/threads/candidate":
			doneMutations++
			writer.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	config := Config{
		Server: ServerConfig{Host: "127.0.0.1", Port: 3001, Schedule: "0 * * * * *"},
		GitHub: GitHubConfig{TokenEnv: "GITHUB_TOKEN", MaxPages: 5},
		Rules: []RuleConfig{{
			Name:    "stale-review",
			When:    `notification.reason == "review_requested" and subject.reviewPending == false`,
			Actions: []ActionConfig{{Type: "done"}},
		}},
	}
	client := github.NewClientWithBaseURL("token", server.Client(), server.URL)
	poller, err := NewPoller(config, client, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	url := server.URL + subjectPath
	irrelevant := testNotification("irrelevant", "mention", url)
	if _, err := poller.processNotification(context.Background(), irrelevant); err != nil {
		t.Fatal(err)
	}
	if subjectFetches != 0 {
		t.Fatalf("unrelated notification fetched subject %d times", subjectFetches)
	}

	candidate := testNotification("candidate", "review_requested", url)
	matched, err := poller.processNotification(context.Background(), candidate)
	if err != nil {
		t.Fatal(err)
	}
	if matched != 1 || subjectFetches != 1 || doneMutations != 1 {
		t.Fatalf("unexpected lazy evaluation: matched=%d fetches=%d mutations=%d", matched, subjectFetches, doneMutations)
	}
}

func testNotification(id, reason, subjectURL string) github.Notification {
	var notification github.Notification
	notification.ID = id
	notification.Unread = true
	notification.Reason = reason
	notification.UpdatedAt = time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)
	notification.Repository.FullName = "a/b"
	notification.Subject.Title = "review"
	notification.Subject.Type = "PullRequest"
	notification.Subject.URL = &subjectURL
	return notification
}
