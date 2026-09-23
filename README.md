# github-notifications

Automatically manage GitHub notifications with a small rule language.

The TypeScript implementation has been removed. This change does not add its replacement.

## Configuration

Copy the example configuration and provide a GitHub token:

```sh
cp config.example.yaml config.yaml
export GITHUB_TOKEN="$(gh auth token)"
```

The token needs the `repo` scope. Set `CONFIG_PATH` to load a different configuration file.

See [`config.example.yaml`](./config.example.yaml) for the server settings and example rules.

## Rules

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

Actions are `read`, `done`, and `unsubscribe`. GitHub has no mark-unread endpoint.

## License

[MIT](./LICENSE)
