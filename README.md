# github-notifications

Manage GitHub notifications with configurable rules. The service is written in Go.

## Requirements

- Go 1.23 or later
- A GitHub classic PAT with the `repo` scope

## Configuration

Copy the example config and provide a token:

```sh
cp config.example.yaml config.yaml
export GITHUB_TOKEN="$(gh auth token)"
```

The config sets the cron schedule, page limit, and notification rules. See [`config.example.yaml`](./config.example.yaml) for a complete example.

## Run

```sh
go run ./cmd/github-notifications
```

The service polls once at startup, then follows the configured schedule while respecting GitHub's `X-Poll-Interval`. It serves `/` and `/health` on the configured loopback address.

## Rules

Each rule has a `name`, a `when` expression, and a list of `actions`. Supported operators are:

```text
==  !=  >  >=  <  <=  contains
and  or  not  ( )
```

Available fields include notification, repository, author, subject, and context fields. Issue and pull request details are fetched only when a rule cannot be decided from notification data alone, then cached with ETags.

Actions are `read`, `done`, and `unsubscribe`. GitHub has no mark-unread endpoint, so `unread` actions are skipped with a warning.

## Development

```sh
go test -race ./...
go vet ./...
go build ./cmd/github-notifications
```
