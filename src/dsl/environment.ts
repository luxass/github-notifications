import { Schema } from "effect";

export const Notification = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
  unread: Schema.Boolean,
  title: Schema.String,
  type: Schema.String,
  updatedAt: Schema.Date,
});

export const Repository = Schema.Struct({
  name: Schema.String,
  owner: Schema.String,
  fullName: Schema.String,
  private: Schema.Boolean,
  stars: Schema.Number,
});

export const NotificationAuthor = Schema.Struct({
  login: Schema.String,
  type: Schema.String,
});

export const QueryContext = Schema.Struct({
  login: Schema.String,
});

export const Subject = Schema.Struct({
  state: Schema.String,
  merged: Schema.Boolean,
  author: Schema.String,
  reviewPending: Schema.Boolean,
});

export type Subject = Schema.Schema.Type<typeof Subject>;

export const QueryEnvironment = Schema.Struct({
  notification: Notification,
  repo: Repository,
  author: NotificationAuthor,
  ctx: QueryContext,
  subject: Subject,
});

export type QueryEnvironment = Schema.Schema.Type<typeof QueryEnvironment>;

export const QueryValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Date,
  Schema.Null,
]);

export type QueryValue = Schema.Schema.Type<typeof QueryValue>;
