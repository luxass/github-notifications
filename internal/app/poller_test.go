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

func TestPollDoesNotAdvanceLastModifiedAfterActionFailure(t *testing.T) {
	const lastModified = "Sat, 19 Sep 2026 10:00:00 GMT"
	var actionAttempts int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/notifications":
			if request.Header.Get("If-Modified-Since") != "" {
				t.Errorf("unexpected conditional request after failed poll: %q", request.Header.Get("If-Modified-Since"))
			}
			writer.Header().Set("Last-Modified", lastModified)
			writer.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprint(writer, `[{"id":"thread-1","unread":true,"reason":"mention","updated_at":"2026-09-19T10:00:00Z","repository":{"full_name":"a/b","private":false},"subject":{"title":"hello","type":"Issue","url":null}}]`)
		case "/notifications/threads/thread-1":
			actionAttempts++
			if actionAttempts == 1 {
				writer.WriteHeader(http.StatusInternalServerError)
				return
			}
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
			Name:    "mark-mention-done",
			When:    `notification.reason == "mention"`,
			Actions: []ActionConfig{{Type: "done"}},
		}},
	}
	poller, err := NewPoller(config, github.NewClientWithBaseURL("token", server.Client(), server.URL), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := poller.Poll(context.Background(), "test"); err == nil {
		t.Fatal("expected first action to fail")
	}
	if poller.lastModified != "" {
		t.Fatalf("lastModified advanced after failed poll: %q", poller.lastModified)
	}
	if _, err := poller.Poll(context.Background(), "test"); err != nil {
		t.Fatalf("second poll failed: %v", err)
	}
	if poller.lastModified != lastModified || actionAttempts != 2 {
		t.Fatalf("notification was not retried: lastModified=%q actionAttempts=%d", poller.lastModified, actionAttempts)
	}
}

func TestFailedSubjectFetchDoesNotRunActions(t *testing.T) {
	const subjectPath = "/repos/a/b/pulls/1"
	var subjectFetches, actionAttempts int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case subjectPath:
			subjectFetches++
			writer.WriteHeader(http.StatusInternalServerError)
		case "/notifications/threads/candidate":
			actionAttempts++
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
			Name:    "not-pending-review",
			When:    `notification.reason == "review_requested" and subject.reviewPending == false`,
			Actions: []ActionConfig{{Type: "done"}},
		}},
	}
	poller, err := NewPoller(config, github.NewClientWithBaseURL("token", server.Client(), server.URL), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}

	matched, err := poller.processNotification(context.Background(), testNotification("candidate", "review_requested", server.URL+subjectPath))
	if err != nil {
		t.Fatal(err)
	}
	if matched != 0 || subjectFetches != 1 || actionAttempts != 0 {
		t.Fatalf("failed subject fetch ran action: matched=%d fetches=%d actions=%d", matched, subjectFetches, actionAttempts)
	}
}
