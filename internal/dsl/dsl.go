package dsl

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

type tokenKind uint8

const (
	tokenEOF tokenKind = iota
	tokenIdentifier
	tokenLiteral
	tokenOperator
	tokenAnd
	tokenOr
	tokenNot
	tokenContains
	tokenDot
	tokenLeftParen
	tokenRightParen
)

type token struct {
	kind  tokenKind
	value any
	start int
	end   int
}

type Expression interface{ expression() }

type Logical struct {
	Operator string
	Left     Expression
	Right    Expression
}

func (Logical) expression() {}

type Comparison struct {
	Operator string
	Left     Expression
	Right    Expression
}

func (Comparison) expression() {}

type Unary struct {
	Operator   string
	Expression Expression
}

func (Unary) expression() {}

type Member struct{ Path []string }

func (Member) expression() {}

type Literal struct{ Value any }

func (Literal) expression() {}

type ParseError struct {
	Message  string
	Position int
}

func (e *ParseError) Error() string { return fmt.Sprintf("%s at position %d", e.Message, e.Position) }

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

type EvaluationError struct{ Message string }

func (e *EvaluationError) Error() string { return e.Message }

func tokenize(source string) ([]token, error) {
	tokens := make([]token, 0, len(source)/2)
	for offset := 0; offset < len(source); {
		r, size := utf8.DecodeRuneInString(source[offset:])
		if unicode.IsSpace(r) {
			offset += size
			continue
		}

		start := offset
		switch {
		case r == '"':
			offset += size
			var value strings.Builder
			closed := false
			for offset < len(source) {
				current, currentSize := utf8.DecodeRuneInString(source[offset:])
				offset += currentSize
				if current == '"' {
					closed = true
					break
				}
				if current != '\\' {
					value.WriteRune(current)
					continue
				}
				if offset >= len(source) {
					return nil, &ParseError{Message: "Unterminated string escape", Position: start}
				}
				escaped, escapedSize := utf8.DecodeRuneInString(source[offset:])
				offset += escapedSize
				switch escaped {
				case '"':
					value.WriteByte('"')
				case '\\':
					value.WriteByte('\\')
				case 'n':
					value.WriteByte('\n')
				case 'r':
					value.WriteByte('\r')
				case 't':
					value.WriteByte('\t')
				default:
					return nil, &ParseError{Message: fmt.Sprintf("Unsupported string escape \\%c", escaped), Position: offset - escapedSize}
				}
			}
			if !closed {
				return nil, &ParseError{Message: "Unterminated string", Position: start}
			}
			tokens = append(tokens, token{kind: tokenLiteral, value: value.String(), start: start, end: offset})

		case unicode.IsDigit(r):
			offset += size
			for offset < len(source) {
				next, nextSize := utf8.DecodeRuneInString(source[offset:])
				if !unicode.IsDigit(next) {
					break
				}
				offset += nextSize
			}
			if offset < len(source) && source[offset] == '.' && offset+1 < len(source) && source[offset+1] >= '0' && source[offset+1] <= '9' {
				offset++
				for offset < len(source) && source[offset] >= '0' && source[offset] <= '9' {
					offset++
				}
			}
			value, err := strconv.ParseFloat(source[start:offset], 64)
			if err != nil {
				return nil, &ParseError{Message: "Invalid number", Position: start}
			}
			tokens = append(tokens, token{kind: tokenLiteral, value: value, start: start, end: offset})

		case isIdentifierStart(r):
			offset += size
			for offset < len(source) {
				next, nextSize := utf8.DecodeRuneInString(source[offset:])
				if !isIdentifierPart(next) {
					break
				}
				offset += nextSize
			}
			word := source[start:offset]
			switch word {
			case "and":
				tokens = append(tokens, token{kind: tokenAnd, start: start, end: offset})
			case "or":
				tokens = append(tokens, token{kind: tokenOr, start: start, end: offset})
			case "not":
				tokens = append(tokens, token{kind: tokenNot, start: start, end: offset})
			case "contains":
				tokens = append(tokens, token{kind: tokenContains, start: start, end: offset})
			case "true":
				tokens = append(tokens, token{kind: tokenLiteral, value: true, start: start, end: offset})
			case "false":
				tokens = append(tokens, token{kind: tokenLiteral, value: false, start: start, end: offset})
			case "null":
				tokens = append(tokens, token{kind: tokenLiteral, value: nil, start: start, end: offset})
			default:
				tokens = append(tokens, token{kind: tokenIdentifier, value: word, start: start, end: offset})
			}

		case r == '=' || r == '!' || r == '>' || r == '<':
			offset += size
			if offset < len(source) && source[offset] == '=' {
				offset++
			}
			operator := source[start:offset]
			if operator == "=" || operator == "!" {
				return nil, &ParseError{Message: fmt.Sprintf("Unexpected operator %q", operator), Position: start}
			}
			tokens = append(tokens, token{kind: tokenOperator, value: operator, start: start, end: offset})

		case r == '.':
			offset += size
			tokens = append(tokens, token{kind: tokenDot, start: start, end: offset})
		case r == '(':
			offset += size
			tokens = append(tokens, token{kind: tokenLeftParen, start: start, end: offset})
		case r == ')':
			offset += size
			tokens = append(tokens, token{kind: tokenRightParen, start: start, end: offset})
		default:
			return nil, &ParseError{Message: fmt.Sprintf("Unexpected character %q", r), Position: start}
		}
	}
	tokens = append(tokens, token{kind: tokenEOF, start: len(source), end: len(source)})
	return tokens, nil
}

func isIdentifierStart(r rune) bool { return unicode.IsLetter(r) || r == '_' }
func isIdentifierPart(r rune) bool  { return isIdentifierStart(r) || unicode.IsDigit(r) }

type parser struct {
	tokens []token
	index  int
}

func Parse(source string) (Expression, error) {
	if strings.TrimSpace(source) == "" {
		return nil, &ParseError{Message: "Expected an expression", Position: 0}
	}
	tokens, err := tokenize(source)
	if err != nil {
		return nil, err
	}
	p := parser{tokens: tokens}
	expression, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if p.current().kind != tokenEOF {
		return nil, p.errorAtCurrent("Unexpected token after expression")
	}
	return expression, nil
}

func (p *parser) parseOr() (Expression, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.match(tokenOr) {
		right, parseErr := p.parseAnd()
		if parseErr != nil {
			return nil, parseErr
		}
		left = Logical{Operator: "or", Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parseAnd() (Expression, error) {
	left, err := p.parseNot()
	if err != nil {
		return nil, err
	}
	for p.match(tokenAnd) {
		right, parseErr := p.parseNot()
		if parseErr != nil {
			return nil, parseErr
		}
		left = Logical{Operator: "and", Left: left, Right: right}
	}
	return left, nil
}

func (p *parser) parseNot() (Expression, error) {
	if p.match(tokenNot) {
		expression, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return Unary{Operator: "not", Expression: expression}, nil
	}
	return p.parseComparison()
}

func (p *parser) parseComparison() (Expression, error) {
	left, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	current := p.current()
	operator := ""
	if current.kind == tokenOperator || current.kind == tokenContains {
		if current.kind == tokenContains {
			operator = "contains"
		} else {
			operator = fmt.Sprint(current.value)
		}
		p.advance()
		right, parseErr := p.parsePrimary()
		if parseErr != nil {
			return nil, parseErr
		}
		left = Comparison{Operator: operator, Left: left, Right: right}
	}
	if p.current().kind == tokenOperator || p.current().kind == tokenContains {
		return nil, p.errorAtCurrent("A comparison can only have one operator")
	}
	return left, nil
}

func (p *parser) parsePrimary() (Expression, error) {
	current := p.current()
	switch current.kind {
	case tokenLiteral:
		p.advance()
		return Literal{Value: current.value}, nil
	case tokenIdentifier:
		p.advance()
		path := []string{current.value.(string)}
		for p.match(tokenDot) {
			next := p.current()
			if next.kind != tokenIdentifier {
				return nil, p.errorAtCurrent("Expected a field name after dot")
			}
			path = append(path, next.value.(string))
			p.advance()
		}
		return Member{Path: path}, nil
	case tokenLeftParen:
		p.advance()
		expression, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if !p.match(tokenRightParen) {
			return nil, p.errorAtCurrent("Expected closing parenthesis")
		}
		return expression, nil
	default:
		return nil, p.errorAtCurrent("Expected a field, literal, or parenthesized expression")
	}
}

func (p *parser) current() token { return p.tokens[p.index] }
func (p *parser) advance() {
	if p.index < len(p.tokens)-1 {
		p.index++
	}
}
func (p *parser) match(kind tokenKind) bool {
	if p.current().kind != kind {
		return false
	}
	p.advance()
	return true
}
func (p *parser) errorAtCurrent(message string) error {
	return &ParseError{Message: message, Position: p.current().start}
}

type valueType uint8

const (
	typeString valueType = iota
	typeNumber
	typeBoolean
	typeDate
	typeNull
)

var fieldTypes = map[string]valueType{
	"notification.id": typeString, "notification.reason": typeString, "notification.unread": typeBoolean,
	"notification.title": typeString, "notification.type": typeString, "notification.updatedAt": typeDate,
	"repo.name": typeString, "repo.owner": typeString, "repo.fullName": typeString,
	"repo.private": typeBoolean,
	"author.login": typeString, "author.type": typeString,
	"subject.state": typeString, "subject.merged": typeBoolean, "subject.author": typeString,
	"subject.reviewPending": typeBoolean,
}

func Validate(expression Expression) error {
	switch node := expression.(type) {
	case Logical:
		if err := Validate(node.Left); err != nil {
			return err
		}
		return Validate(node.Right)
	case Unary:
		return Validate(node.Expression)
	case Comparison:
		left, ok := node.Left.(Member)
		if !ok {
			return &ValidationError{Message: "Left side of comparison must be a field"}
		}
		leftPath := strings.Join(left.Path, ".")
		leftType, exists := fieldTypes[leftPath]
		if !exists {
			return &ValidationError{Message: "Unknown field " + leftPath}
		}
		var rightType valueType
		switch right := node.Right.(type) {
		case Member:
			path := strings.Join(right.Path, ".")
			var found bool
			rightType, found = fieldTypes[path]
			if !found {
				return &ValidationError{Message: "Unknown field " + path}
			}
		case Literal:
			rightType = literalType(right.Value)
		default:
			return &ValidationError{Message: "Right side of comparison must be a field or literal"}
		}
		if node.Operator == "contains" {
			if leftType == typeString && rightType == typeString {
				return nil
			}
			return &ValidationError{Message: "Operator contains requires string operands"}
		}
		if node.Operator == "==" || node.Operator == "!=" {
			if rightType == typeNull || leftType == rightType {
				return nil
			}
			if leftType == typeDate && rightType == typeString {
				literal, ok := node.Right.(Literal)
				if !ok {
					return &ValidationError{Message: "Date fields must be compared with a date field or ISO date string"}
				}
				if _, err := parseDate(literal.Value); err != nil {
					return &ValidationError{Message: fmt.Sprintf("Invalid date literal %q", literal.Value)}
				}
				return nil
			}
			return &ValidationError{Message: fmt.Sprintf("Cannot compare %s with %s", typeName(leftType), typeName(rightType))}
		}
		if leftType != typeNumber && leftType != typeDate {
			return &ValidationError{Message: fmt.Sprintf("Operator %s cannot be used with %s", node.Operator, typeName(leftType))}
		}
		if leftType == typeNumber && rightType == typeNumber {
			return nil
		}
		if leftType == typeDate && rightType == typeDate {
			return nil
		}
		if leftType == typeDate && rightType == typeString {
			literal, ok := node.Right.(Literal)
			if !ok {
				return &ValidationError{Message: "Date fields must be compared with a date field or ISO date string"}
			}
			if _, err := parseDate(literal.Value); err != nil {
				return &ValidationError{Message: fmt.Sprintf("Invalid date literal %q", literal.Value)}
			}
			return nil
		}
		return &ValidationError{Message: fmt.Sprintf("Operator %s cannot compare %s with %s", node.Operator, typeName(leftType), typeName(rightType))}
	case Member:
		path := strings.Join(node.Path, ".")
		typ, exists := fieldTypes[path]
		if !exists {
			return &ValidationError{Message: "Unknown field " + path}
		}
		if typ != typeBoolean {
			return &ValidationError{Message: fmt.Sprintf("Bare field %s must be boolean, got %s", path, typeName(typ))}
		}
		return nil
	case Literal:
		return &ValidationError{Message: "A literal cannot be used directly as a condition"}
	default:
		return &ValidationError{Message: "Unknown expression node"}
	}
}

func literalType(value any) valueType {
	switch value.(type) {
	case string:
		return typeString
	case float64:
		return typeNumber
	case bool:
		return typeBoolean
	case nil:
		return typeNull
	default:
		return typeNull
	}
}
func typeName(typ valueType) string {
	switch typ {
	case typeString:
		return "string"
	case typeNumber:
		return "number"
	case typeBoolean:
		return "boolean"
	case typeDate:
		return "date"
	default:
		return "null"
	}
}
