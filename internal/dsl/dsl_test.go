package dsl

import (
	"strings"
	"testing"
	"time"
)

func TestParseValidateAndEvaluate(t *testing.T) {
	expression, err := Parse(`notification.reason == "review_requested" and (subject.reviewPending == false or repo.stars >= 2)`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}

	environment := Environment{
		Notification: NotificationFields{Reason: "mention", UpdatedAt: time.Date(2026, 9, 19, 10, 0, 0, 0, time.UTC)},
		Repo:         RepositoryFields{Stars: 4},
	}
	result, err := Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != False {
		t.Fatalf("unrelated notification should rule out subject lookup, got %v", result)
	}

	environment.Notification.Reason = "review_requested"
	result, err = Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("true notification-only branch should not need subject data, got %v", result)
	}

	environment.Repo.Stars = 0
	result, err = Evaluate(expression, environment, false)
	if err != nil {
		t.Fatal(err)
	}
	if result != Unknown {
		t.Fatalf("subject-dependent candidate should be unknown, got %v", result)
	}

	environment.Subject.ReviewPending = false
	result, err = Evaluate(expression, environment, true)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("subject details should resolve candidate to true, got %v", result)
	}
}

func TestOperatorPrecedenceAndNot(t *testing.T) {
	expression, err := Parse(`not notification.unread or repo.stars > 10 and repo.private == false`)
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}
	result, err := Evaluate(expression, Environment{
		Notification: NotificationFields{Unread: true},
		Repo:         RepositoryFields{Stars: 20, Private: false},
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	if result != True {
		t.Fatalf("expected and to bind more tightly than or, got %v", result)
	}
}

func TestValidationRejectsUnknownAndIllTypedExpressions(t *testing.T) {
	for _, source := range []string{
		`banana.reason == "mention"`,
		`notification.title`,
		`repo.stars contains "4"`,
		`"mention" == notification.reason`,
		`notification.updatedAt > "not-a-date"`,
	} {
		expression, err := Parse(source)
		if err != nil {
			t.Fatalf("Parse(%q): %v", source, err)
		}
		if err := Validate(expression); err == nil {
			t.Errorf("Validate(%q) succeeded, expected error", source)
		}
	}
}

func TestParseRejectsMalformedExpressions(t *testing.T) {
	for _, source := range []string{"", "a ==", "a == 1 == 2", "a in b", "(a == 1", `"unterminated`} {
		if _, err := Parse(source); err == nil {
			t.Errorf("Parse(%q) succeeded, expected error", source)
		}
	}
}

func TestMultilineRulesAndEscapes(t *testing.T) {
	expression, err := Parse(strings.Join([]string{
		`notification.title contains "Run \"failed\""`,
		`and notification.unread == true`,
	}, "\n"))
	if err != nil {
		t.Fatal(err)
	}
	if err := Validate(expression); err != nil {
		t.Fatal(err)
	}
}
