package github

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestListNotificationsUsesConditionalHeadersAndPollInterval(t *testing.T) {
	var sawConditional bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("unexpected authorization header %q", request.Header.Get("Authorization"))
		}
		if request.URL.Query().Get("all") != "true" || request.URL.Query().Get("participating") != "false" {
			t.Errorf("unexpected query: %s", request.URL.RawQuery)
		}
		if request.Header.Get("If-Modified-Since") == "Sat, 19 Sep 2026 10:00:00 GMT" {
			sawConditional = true
			writer.Header().Set("X-Poll-Interval", "90")
			writer.WriteHeader(http.StatusNotModified)
			return
		}
		writer.Header().Set("Last-Modified", "Sat, 19 Sep 2026 10:00:00 GMT")
		writer.Header().Set("X-Poll-Interval", "120")
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprint(writer, `[{"id":"1","unread":true,"reason":"mention","updated_at":"2026-09-19T10:00:00Z","repository":{"full_name":"a/b"},"subject":{"title":"hello","type":"Issue","url":null}}]`)
	}))
	defer server.Close()

	client := NewClientWithBaseURL("test-token", server.Client(), server.URL)
	first, err := client.ListNotifications(context.Background(), "", 5)
	if err != nil {
		t.Fatal(err)
	}
	if first.NotModified || len(first.Notifications) != 1 || first.LastModified == "" || first.PollAfter.Seconds() != 125 {
		t.Fatalf("unexpected first result: %#v", first)
	}
	second, err := client.ListNotifications(context.Background(), first.LastModified, 5)
	if err != nil {
		t.Fatal(err)
	}
	if !sawConditional || !second.NotModified || second.PollAfter.Seconds() != 95 {
		t.Fatalf("unexpected conditional result: sawConditional=%v result=%#v", sawConditional, second)
	}
}

func TestSubjectETagCache(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.Header.Get("If-None-Match") == `"v1"` {
			writer.WriteHeader(http.StatusNotModified)
			return
		}
		writer.Header().Set("ETag", `"v1"`)
		fmt.Fprint(writer, `{"state":"closed","user":{"login":"dependabot[bot]"},"requested_reviewers":[{"login":"octocat"}]}`)
	}))
	defer server.Close()

	client := NewClientWithBaseURL("test-token", server.Client(), server.URL)
	url := server.URL + "/repos/a/b/pulls/1"
	first, err := client.GetSubject(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.GetSubject(context.Background(), url)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || first == nil || second == nil || *first != *second {
		t.Fatalf("unexpected subject cache result: requests=%d first=%#v second=%#v", requests, first, second)
	}
	if first.Author != "dependabot" || first.State != "closed" || !first.ReviewPending {
		t.Fatalf("unexpected subject details: %#v", first)
	}
}

func TestMutationsAndUnexpectedSubjectURL(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/notifications/threads/42" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	client := NewClientWithBaseURL("test-token", server.Client(), server.URL)
	if err := client.MarkThreadDone(context.Background(), "42"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetSubject(context.Background(), "https://evil.example/steal"); err == nil || !strings.Contains(err.Error(), "unexpected GitHub subject URL") {
		t.Fatalf("expected unexpected URL error, got %v", err)
	}
}

func TestMutationTreatsMissingThreadAsSuccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	client := NewClientWithBaseURL("test-token", server.Client(), server.URL)
	if err := client.MarkThreadDone(context.Background(), "42"); err != nil {
		t.Fatal(err)
	}
}
