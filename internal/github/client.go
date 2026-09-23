package github

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	defaultAPIURL = "https://api.github.com"
	perPage       = 50
	cacheLimit    = 2000
)

type Notification struct {
	ID         string    `json:"id"`
	Unread     bool      `json:"unread"`
	Reason     string    `json:"reason"`
	UpdatedAt  time.Time `json:"updated_at"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	Subject struct {
		Title string  `json:"title"`
		Type  string  `json:"type"`
		URL   *string `json:"url"`
	} `json:"subject"`
}

type SubjectDetails struct {
	State         string
	Merged        bool
	Author        string
	ReviewPending bool
}

type ListResult struct {
	NotModified   bool
	Notifications []Notification
	PollAfter     time.Duration
	LastModified  string
	Truncated     bool
}

type Client struct {
	httpClient *http.Client
	baseURL    string
	token      string
	subjects   map[string]cachedSubject
}

type cachedSubject struct {
	etag    string
	details SubjectDetails
}

func NewClient(token string, httpClient *http.Client) *Client {
	return NewClientWithBaseURL(token, httpClient, defaultAPIURL)
}

func NewClientWithBaseURL(token string, httpClient *http.Client, baseURL string) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		httpClient: httpClient,
		baseURL:    strings.TrimRight(baseURL, "/"),
		token:      token,
		subjects:   make(map[string]cachedSubject),
	}
}

func (client *Client) ListNotifications(ctx context.Context, lastModified string, maxPages int) (ListResult, error) {
	if maxPages < 1 {
		maxPages = 1
	}
	result := ListResult{PollAfter: defaultPollInterval()}

	for page := 1; page <= maxPages; page++ {
		endpoint, err := url.Parse(client.baseURL + "/notifications")
		if err != nil {
			return result, err
		}
		query := endpoint.Query()
		query.Set("all", "true")
		query.Set("participating", "false")
		query.Set("per_page", strconv.Itoa(perPage))
		query.Set("page", strconv.Itoa(page))
		endpoint.RawQuery = query.Encode()

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return result, err
		}
		client.setHeaders(req)
		if page == 1 && lastModified != "" {
			req.Header.Set("If-Modified-Since", lastModified)
		}

		resp, err := client.httpClient.Do(req)
		if err != nil {
			return result, fmt.Errorf("GitHub GET %s: %w", endpoint, err)
		}
		if page == 1 {
			result.PollAfter = parsePollInterval(resp.Header.Get("X-Poll-Interval"))
			result.LastModified = resp.Header.Get("Last-Modified")
		}
		if resp.StatusCode == http.StatusNotModified {
			resp.Body.Close()
			if page != 1 {
				return result, fmt.Errorf("GitHub returned 304 for paginated notifications")
			}
			result.NotModified = true
			return result, nil
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			err := responseError(resp, endpoint.String())
			resp.Body.Close()
			return result, err
		}

		var notifications []Notification
		decodeErr := json.NewDecoder(resp.Body).Decode(&notifications)
		resp.Body.Close()
		if decodeErr != nil {
			return result, fmt.Errorf("decode GitHub notifications: %w", decodeErr)
		}
		result.Notifications = append(result.Notifications, notifications...)
		if len(notifications) < perPage {
			return result, nil
		}
	}
	result.Truncated = true
	return result, nil
}

func (client *Client) GetSubject(ctx context.Context, subjectURL string) (*SubjectDetails, error) {
	parsed, err := url.Parse(subjectURL)
	base, baseErr := url.Parse(client.baseURL)
	if err != nil || baseErr != nil || parsed.Scheme != base.Scheme || parsed.Host != base.Host || parsed.User != nil {
		return nil, fmt.Errorf("refusing unexpected GitHub subject URL %q", subjectURL)
	}
	cached, hasCache := client.subjects[subjectURL]
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, subjectURL, nil)
	if err != nil {
		return nil, err
	}
	client.setHeaders(req)
	if hasCache {
		req.Header.Set("If-None-Match", cached.etag)
	}
	resp, err := client.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GitHub GET %s: %w", subjectURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified && hasCache {
		details := cached.details
		return &details, nil
	}
	if resp.StatusCode == http.StatusNotFound {
		return nil, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, responseError(resp, subjectURL)
	}

	var payload struct {
		State  string `json:"state"`
		Merged bool   `json:"merged"`
		User   *struct {
			Login string `json:"login"`
		} `json:"user"`
		RequestedReviewers []struct {
			Login string `json:"login"`
		} `json:"requested_reviewers"`
		RequestedTeams []struct {
			Slug string `json:"slug"`
		} `json:"requested_teams"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("decode GitHub subject: %w", err)
	}
	author := "unknown"
	if payload.User != nil && payload.User.Login != "" {
		author = strings.TrimSuffix(payload.User.Login, "[bot]")
	}
	details := SubjectDetails{
		State:         payload.State,
		Merged:        payload.Merged,
		Author:        author,
		ReviewPending: len(payload.RequestedReviewers)+len(payload.RequestedTeams) > 0,
	}
	if etag := resp.Header.Get("ETag"); etag != "" {
		if len(client.subjects) >= cacheLimit {
			clear(client.subjects)
		}
		client.subjects[subjectURL] = cachedSubject{etag: etag, details: details}
	}
	return &details, nil
}

func (client *Client) MarkThreadRead(ctx context.Context, threadID string) error {
	return client.mutateThread(ctx, http.MethodPatch, "/notifications/threads/"+url.PathEscape(threadID), http.StatusResetContent, http.StatusNotModified)
}

func (client *Client) MarkThreadDone(ctx context.Context, threadID string) error {
	return client.mutateThread(ctx, http.MethodDelete, "/notifications/threads/"+url.PathEscape(threadID), http.StatusNoContent, http.StatusNotFound)
}

func (client *Client) DeleteThreadSubscription(ctx context.Context, threadID string) error {
	return client.mutateThread(ctx, http.MethodDelete, "/notifications/threads/"+url.PathEscape(threadID)+"/subscription", http.StatusNoContent, http.StatusNotFound)
}

func (client *Client) mutateThread(ctx context.Context, method, path string, expected int, tolerated ...int) error {
	endpoint := client.baseURL + path
	req, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return err
	}
	client.setHeaders(req)
	resp, err := client.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("GitHub %s %s: %w", method, endpoint, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == expected {
		return nil
	}
	for _, status := range tolerated {
		if resp.StatusCode == status {
			return nil
		}
	}
	return responseError(resp, endpoint)
}

func (client *Client) setHeaders(req *http.Request) {
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "Bearer "+client.token)
	req.Header.Set("User-Agent", "github-notifications-go")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
}

func parsePollInterval(value string) time.Duration {
	seconds, err := strconv.Atoi(value)
	if err != nil || seconds <= 0 {
		seconds = 60
	}
	return time.Duration(seconds)*time.Second + 5*time.Second
}

func defaultPollInterval() time.Duration { return 65 * time.Second }

func responseError(resp *http.Response, endpoint string) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2000))
	message := fmt.Sprintf("GitHub request %s failed with HTTP %d", endpoint, resp.StatusCode)
	if len(body) > 0 {
		message += ": " + strings.TrimSpace(string(body))
	}
	return fmt.Errorf("%s", message)
}
