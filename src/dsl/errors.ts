import { Schema } from "effect";

export class TokenizeError extends Schema.TaggedError<TokenizeError>()("TokenizeError", {
  message: Schema.String,
  position: Schema.Number,
}) {}

export class ParseError extends Schema.TaggedError<ParseError>()("ParseError", {
  message: Schema.String,
  position: Schema.Number,
}) {}

export class ValidationError extends Schema.TaggedError<ValidationError>()("ValidationError", {
  message: Schema.String,
}) {}

export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  message: Schema.String,
}) {}
