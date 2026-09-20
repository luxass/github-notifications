# 🔔 github-notifications

Automatically manage GitHub notifications with a small rule language.

Built with [Effect](https://effect.website/), TypeScript, and Node.js.

## 📦 Installation

```sh
pnpm install
```

## ⚙️ Configuration

Copy the example configuration and provide a GitHub token:

```sh
cp config.example.yaml config.yaml
export GITHUB_TOKEN="$(gh auth token)"
```

The token needs the `repo` scope. Set `CONFIG_PATH` to load a different
configuration file.

```yaml
server:
  host: 127.0.0.1
  port: 3001
  schedule: "0 * * * * *"

github:
  tokenEnv: GITHUB_TOKEN
  maxPages: 10

rules:
  - name: workflow-failures
    when: notification.reason == "ci_activity" and notification.title contains "Run failed"
    actions:
      - type: done
```

See [`config.example.yaml`](./config.example.yaml) for more rules.

## 🚀 Usage

```sh
pnpm server
```

The service polls once at startup and then follows the configured schedule.

```sh
curl http://127.0.0.1:3001/
curl http://127.0.0.1:3001/health
```

## 📚 Rules

Rules contain a `name`, a `when` expression, and a list of `actions`.

Supported operators:

```text
==  !=  >  >=  <  <=  contains
and  or  not  ( )
```

Available fields include:

- `notification.id`, `reason`, `unread`, `title`, `type`, `updatedAt`
- `repo.name`, `owner`, `fullName`, `private`, `stars`
- `author.login`, `author.type`
- `subject.state`, `merged`, `author`, `reviewPending`
- `ctx.login`

Issue and pull request subjects are fetched when needed and cached with ETags.

### Actions

- `read` — mark a thread as read
- `done` — delete a thread
- `unsubscribe` — unsubscribe from a thread

GitHub has no mark-unread endpoint, so `unread` is not supported.

## 🛠️ Development

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm build
```

`pnpm build` creates a Node bundle and standalone executables for macOS arm64,
Linux x64, and Windows x64.

## 📄 License

Published under the [MIT License](./LICENSE).
