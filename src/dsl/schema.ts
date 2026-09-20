import { Schema } from "effect";

import type { QueryEnvironment, QueryValue } from "./environment.ts";

export const FieldType = Schema.Literals(["string", "number", "boolean", "date"]);

export type FieldType = Schema.Schema.Type<typeof FieldType>;

export interface FieldEntry {
  readonly type: FieldType;
  readonly read: (env: QueryEnvironment) => QueryValue;
}

export interface FieldTable {
  readonly [path: string]: FieldEntry | undefined;
}

export const fieldDefinitions: FieldTable = {
  "notification.id": {
    type: "string",
    read: (env: QueryEnvironment) => env.notification.id,
  },
  "notification.reason": {
    type: "string",
    read: (env: QueryEnvironment) => env.notification.reason,
  },
  "notification.unread": {
    type: "boolean",
    read: (env: QueryEnvironment) => env.notification.unread,
  },
  "notification.title": {
    type: "string",
    read: (env: QueryEnvironment) => env.notification.title,
  },
  "notification.type": {
    type: "string",
    read: (env: QueryEnvironment) => env.notification.type,
  },
  "notification.updatedAt": {
    type: "date",
    read: (env: QueryEnvironment) => env.notification.updatedAt,
  },
  "repo.name": {
    type: "string",
    read: (env: QueryEnvironment) => env.repo.name,
  },
  "repo.owner": {
    type: "string",
    read: (env: QueryEnvironment) => env.repo.owner,
  },
  "repo.fullName": {
    type: "string",
    read: (env: QueryEnvironment) => env.repo.fullName,
  },
  "repo.private": {
    type: "boolean",
    read: (env: QueryEnvironment) => env.repo.private,
  },
  "repo.stars": {
    type: "number",
    read: (env: QueryEnvironment) => env.repo.stars,
  },
  "author.login": {
    type: "string",
    read: (env: QueryEnvironment) => env.author.login,
  },
  "author.type": {
    type: "string",
    read: (env: QueryEnvironment) => env.author.type,
  },
  "ctx.login": {
    type: "string",
    read: (env: QueryEnvironment) => env.ctx.login,
  },
  "subject.state": {
    type: "string",
    read: (env: QueryEnvironment) => env.subject.state,
  },
  "subject.merged": {
    type: "boolean",
    read: (env: QueryEnvironment) => env.subject.merged,
  },
  "subject.author": {
    type: "string",
    read: (env: QueryEnvironment) => env.subject.author,
  },
  "subject.reviewPending": {
    type: "boolean",
    read: (env: QueryEnvironment) => env.subject.reviewPending,
  },
};
