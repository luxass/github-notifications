package dsl

import (
	"fmt"
	"strings"
	"time"
)

type Truth uint8

const (
	False Truth = iota
	True
	Unknown
)

type Environment struct {
	Notification NotificationFields
	Repo         RepositoryFields
	Author       AuthorFields
	Context      ContextFields
	Subject      SubjectFields
}

type NotificationFields struct {
	ID        string
	Reason    string
	Unread    bool
	Title     string
	Type      string
	UpdatedAt time.Time
}

type RepositoryFields struct {
	Name     string
	Owner    string
	FullName string
	Private  bool
	Stars    float64
}

type AuthorFields struct {
	Login string
	Type  string
}

type ContextFields struct{ Login string }

type SubjectFields struct {
	State         string
	Merged        bool
	Author        string
	ReviewPending bool
}

func Evaluate(expression Expression, environment Environment, subjectAvailable bool) (Truth, error) {
	switch node := expression.(type) {
	case Logical:
		left, err := Evaluate(node.Left, environment, subjectAvailable)
		if err != nil {
			return False, err
		}
		if node.Operator == "and" && left == False {
			return False, nil
		}
		if node.Operator == "or" && left == True {
			return True, nil
		}
		right, err := Evaluate(node.Right, environment, subjectAvailable)
		if err != nil {
			return False, err
		}
		if node.Operator == "and" {
			if right == False {
				return False, nil
			}
			if left == True && right == True {
				return True, nil
			}
			return Unknown, nil
		}
		if right == True {
			return True, nil
		}
		if left == False && right == False {
			return False, nil
		}
		return Unknown, nil

	case Unary:
		value, err := Evaluate(node.Expression, environment, subjectAvailable)
		if err != nil || value == Unknown {
			return value, err
		}
		if value == True {
			return False, nil
		}
		return True, nil

	case Member:
		value, unknown, err := readMember(node, environment, subjectAvailable)
		if err != nil {
			return False, err
		}
		if unknown {
			return Unknown, nil
		}
		boolean, ok := value.(bool)
		if !ok {
			return False, &EvaluationError{Message: strings.Join(node.Path, ".") + " is not a boolean field"}
		}
		if boolean {
			return True, nil
		}
		return False, nil

	case Comparison:
		left, leftUnknown, err := readValue(node.Left, environment, subjectAvailable)
		if err != nil {
			return False, err
		}
		right, rightUnknown, err := readValue(node.Right, environment, subjectAvailable)
		if err != nil {
			return False, err
		}
		if leftUnknown || rightUnknown {
			return Unknown, nil
		}
		matched, err := compare(node.Operator, left, right)
		if err != nil {
			return False, err
		}
		if matched {
			return True, nil
		}
		return False, nil

	case Literal:
		return False, &EvaluationError{Message: "A literal cannot be evaluated directly as a condition"}
	default:
		return False, &EvaluationError{Message: "Unknown expression node"}
	}
}

func readValue(expression Expression, environment Environment, subjectAvailable bool) (any, bool, error) {
	switch node := expression.(type) {
	case Literal:
		return node.Value, false, nil
	case Member:
		return readMember(node, environment, subjectAvailable)
	default:
		return nil, false, &EvaluationError{Message: fmt.Sprintf("Cannot use %T as a comparison value", expression)}
	}
}

func readMember(member Member, environment Environment, subjectAvailable bool) (any, bool, error) {
	path := strings.Join(member.Path, ".")
	if !subjectAvailable && (member.Path[0] == "subject" || member.Path[0] == "author") {
		return nil, true, nil
	}

	switch path {
	case "notification.id":
		return environment.Notification.ID, false, nil
	case "notification.reason":
		return environment.Notification.Reason, false, nil
	case "notification.unread":
		return environment.Notification.Unread, false, nil
	case "notification.title":
		return environment.Notification.Title, false, nil
	case "notification.type":
		return environment.Notification.Type, false, nil
	case "notification.updatedAt":
		return environment.Notification.UpdatedAt, false, nil
	case "repo.name":
		return environment.Repo.Name, false, nil
	case "repo.owner":
		return environment.Repo.Owner, false, nil
	case "repo.fullName":
		return environment.Repo.FullName, false, nil
	case "repo.private":
		return environment.Repo.Private, false, nil
	case "repo.stars":
		return environment.Repo.Stars, false, nil
	case "author.login":
		return environment.Author.Login, false, nil
	case "author.type":
		return environment.Author.Type, false, nil
	case "ctx.login":
		return environment.Context.Login, false, nil
	case "subject.state":
		return environment.Subject.State, false, nil
	case "subject.merged":
		return environment.Subject.Merged, false, nil
	case "subject.author":
		return environment.Subject.Author, false, nil
	case "subject.reviewPending":
		return environment.Subject.ReviewPending, false, nil
	default:
		return nil, false, &EvaluationError{Message: "Unknown field " + path}
	}
}

func compare(operator string, left, right any) (bool, error) {
	if operator == "==" || operator == "!=" {
		equal := equalValues(left, right)
		if operator == "!=" {
			return !equal, nil
		}
		return equal, nil
	}
	if operator == "contains" {
		leftString, leftOK := left.(string)
		rightString, rightOK := right.(string)
		if !leftOK || !rightOK {
			return false, &EvaluationError{Message: "Operator contains requires string operands"}
		}
		return strings.Contains(leftString, rightString), nil
	}

	var ordering int
	switch leftValue := left.(type) {
	case float64:
		rightValue, ok := right.(float64)
		if !ok {
			return false, &EvaluationError{Message: "Cannot compare incompatible values"}
		}
		if leftValue < rightValue {
			ordering = -1
		} else if leftValue > rightValue {
			ordering = 1
		}
	case time.Time:
		rightValue, ok := right.(time.Time)
		if !ok {
			text, stringOK := right.(string)
			if !stringOK {
				return false, &EvaluationError{Message: "Cannot compare incompatible values"}
			}
			parsed, err := parseDate(text)
			if err != nil {
				return false, &EvaluationError{Message: "Cannot compare date with invalid date string"}
			}
			rightValue = parsed
		}
		if leftValue.Before(rightValue) {
			ordering = -1
		} else if leftValue.After(rightValue) {
			ordering = 1
		}
	default:
		return false, &EvaluationError{Message: fmt.Sprintf("Value is not comparable: %T", left)}
	}

	switch operator {
	case ">":
		return ordering > 0, nil
	case ">=":
		return ordering >= 0, nil
	case "<":
		return ordering < 0, nil
	case "<=":
		return ordering <= 0, nil
	default:
		return false, &EvaluationError{Message: "Unknown comparison operator " + operator}
	}
}

func equalValues(left, right any) bool {
	if leftDate, ok := left.(time.Time); ok {
		if rightDate, ok := right.(time.Time); ok {
			return leftDate.Equal(rightDate)
		}
		if text, ok := right.(string); ok {
			parsed, err := parseDate(text)
			return err == nil && leftDate.Equal(parsed)
		}
	}
	if rightDate, ok := right.(time.Time); ok {
		if text, ok := left.(string); ok {
			parsed, err := parseDate(text)
			return err == nil && parsed.Equal(rightDate)
		}
	}
	return left == right
}

func parseDate(value any) (time.Time, error) {
	text, ok := value.(string)
	if !ok {
		return time.Time{}, fmt.Errorf("date literal is not a string")
	}
	return time.Parse(time.RFC3339Nano, text)
}
