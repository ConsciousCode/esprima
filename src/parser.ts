import * as Node from './nodes';

import { Position, RawToken, Scanner } from './scanner';
import { Token, TokenName } from './token';
import { Character } from './character';

interface Elseable {
	name: Node.Identifier | null;
	head: Node.Expression;
	body: Node.Expression;
	alt: Node.Expression | null;
}

/**
 * Unary operator precedences.
**/
const UNARYOPS = {
	"+": 0x40, '-': 0x40,
	"!": 0x41, 'not': 0x41,

	"::": 0xa0
};

/**
 * Binary operation precedences.
**/
const BINARYOPS = {
	// Technical
	';': 0x00,
	//":": 0x01,
	//',': 0x01,
	'=': 0x01,

	// Boolean
	'or': 0x10,
	'and': 0x11,

	// Comparisons
	"<": 0x20, "<=": 0x20,
	">": 0x20, ">=": 0x20,
	"==": 0x20, "!=": 0x20,

	// Arithmetic
	'+': 0x30, '-': 0x30,
	'*': 0x31, '/': 0x31,

	// Groups
	"(": 0xa0, "[": 0xa0, "{": 0xa0,

	// Referencing
	'.': 0xb1
};

/**
 * Operations that are right-associating
**/
const RIGHTOPS = [';', "(", '[', "{"];

const COMPACT = BINARYOPS[';'] + 1, PARAMETER = BINARYOPS[','];

function summarize_token(tok: RawToken): string {
	return TokenName[tok.type] + "{" + tok.value + "}";
}

function should_ignore(t: Token) {
	return (
		t === Token.Whitespace ||
		t === Token.SingleLineComment ||
		t === Token.MultiLineComment
	);
}

/**
 * Parser naming conventions:
 *
 * match* = Return a parsed token or null. Do not consume.
 * expect* = Return a parsed token or throw an error.
 * parse* = The first token has been consumed, parse the
 *  rest and return the result. This will not return null.
 * read* = The first token is unread but predictable.
 *  parse the whole thing and return. This will not return null.
**/
export class Parser {
	readonly scanner: Scanner;

	lookahead: RawToken | null;

	constructor(code: string) {
		this.scanner = new Scanner(code);
		this.lookahead = {
			type: Token.EOF,
			value: ''
		};
		this.nextToken();
	}

	//////////////////////
	/** Error handling **/
	//////////////////////

	summarizePosition(pos: Position): string {
		return (
			"(ln: " + pos.line +
			", col: " + pos.col + "):" +
			pos.start
		)
	}
	
	error(msg: string, pos: Position): Error {
		return new Error(
			`${msg} at ${this.summarizePosition(pos)}`
		)
	}

	unexpectedToken(tok: RawToken): Error {
		return this.error(
			"Unexpected token",
			tok.pos||this.scanner.getPosition()
		);
	}

	////////////////////////////
	/** Low-level processing **/
	////////////////////////////

	consumeToken(): RawToken {
		// Lex until we get a substantive token
		do {
			var la = this.scanner.lex();
		} while(should_ignore(la.type));
		return this.lookahead = la;
	}

	nextToken(): RawToken {
		if(this.lookahead) {
			return this.lookahead;
		}

		return this.consumeToken();
	}
	
	eof(): boolean {
		return this.nextToken().type === Token.EOF;
	}

	/// Expect specific tokens, else error

	expect(type: Token, value: string): RawToken {
		const token = this.nextToken();
		if(token.type !== type || token.value !== value) {
			throw new Error(
				"Expected " + summarize_token({
					type, value: value || ""
				}) +
				", got " + summarize_token(token) +
				" " + this.summarizePosition(token.pos||this.scanner.getPosition())
			);
		}

		this.consumeToken();

		return token;
	}

	expectPunctuator(value: string): RawToken {
		return this.expect(Token.Punctuator, value);
	}

	expectAny(type: Token): RawToken {
		const token = this.nextToken();
		if(token.type !== type) {
			throw new Error(
				"Expected " + summarize_token({
					type, value: "<any>"
				}) +
				", got " + summarize_token(token) +
				" " + this.summarizePosition(token.pos||this.scanner.getPosition())
			);
		}

		this.consumeToken();

		return token;
	}

	expectIdentifier(): Node.Identifier {
		return new Node.Identifier(this.expectAny(Token.Identifier).value);
	}

	expectKeyword(keyword: string): RawToken {
		const tok = this.nextToken();
		if(tok.type !== Token.Keyword || tok.value !== keyword) {
			throw this.unexpectedToken(tok);
		}
		return tok;
	}
	
	/// Try to match, else return null
	
	match(type: Token, value: string): RawToken | null {
		let tok = this.nextToken();
		if(tok.type === type && tok.value === value) {
			return tok;
		}
		return null;
	}
	
	matchAny(type: Token): RawToken | null {
		let tok = this.nextToken()
		if(tok.type === type) {
			return tok;
		}
		return null;
	}
	
	matchPunctuator(value: string): RawToken | null {
		return this.match(Token.Punctuator, value);
	}
	
	matchKeyword(value: string): RawToken | null {
		return this.match(Token.Keyword, value);
	}
	
	//////////////////////
	/** Clause parsing **/
	//////////////////////
	
	parseElseClause(): Node.ElseClause {
		return new Node.ElseClause(this.parseBlock());
	}
	
	readElseClause(): Node.ElseClause|null {
		if(this.matchKeyword('else')) {
			this.consumeToken();
			return this.parseElseClause();
		}
		
		return null;
	}
	
	////////////////////
	/** Atom parsing **/
	////////////////////
	parseParen(open: string): Node.Expression {
		let clauses: (Node.Expression | null)[] = [];
		const close = Character.toGroupClose(open);
		
		for(;;) {
			// Allow consecutive semicolons
			while(this.matchPunctuator(';')) {
				this.consumeToken();
				clauses.push(null);
			}
			
			if(this.match(Token.GroupClose, close)) {
				this.consumeToken();
				break;
			}

			clauses.push(this.parseStatement());
		}

		// () == nil
		if(clauses.length == 0) {
			return new Node.Literal(null);
		}

		// (1) == 1, don't wrap in a block
		if(clauses.length == 1) {
			return clauses[0] as Node.Expression;
		}

		return new Node.Group(clauses);
	}
	
	/**
	 * Parse a group with any opening type. igtype is true if the group
	 *  should be parentheses-like no matter the opening character, such as
	 *  when parsing blocks.
	**/
	parseGroup(open: string, igtype: boolean = false): Node.Expression {
		if(igtype) {
			return this.parseParen(open);
		}
		
		switch(open) {
			case "(": return this.parseParen('(');
			case '[': return this.parseArrayLiteral();
			case "{": return this.parseObjectLiteral();
			
			default:
				throw new Error(`'${open}' is not a group opening`);
		}
	}
	
	expectGroup(): Node.Expression {
		let tok = this.nextToken();
		if(tok.type === Token.GroupOpen) {
			this.consumeToken();
			return this.parseGroup(tok.value);
		}
		
		throw this.unexpectedToken(tok);
	}
	
	/**
	 * This is a common parsing pattern, so abstract it
	 *  Ex: fn(), fn(), ..., fn()
	**/
	parseCommaSeparatedClause(fn) {
		let args: any[] = [];
		
		for(;;) {
			args.push(fn.call(this));
			
			if(this.matchPunctuator(',')) {
				this.consumeToken();
			}
			else {
				break;
			}
		}
		
		return args;
	}

	/**
	 * Parse the parameter definitions clause of a let expression
	**/
	readParamDefs(): Node.FunctionParameter[] {
		let params: Node.FunctionParameter[] = [];
		let start = this.expectAny(Token.GroupOpen);
		
		const END = Character.toGroupClose(start.value);
		
		while(!this.match(Token.GroupClose, END)) {
			let
				name = this.expectAny(Token.Identifier),
				def: Node.Expression | null = null;

			if(this.matchPunctuator('=')) {
				this.consumeToken();

				def = this.parseStatement();
			}

			params.push(new Node.FunctionParameter(
				new Node.Identifier(name.value), def
			));

			if(!this.matchPunctuator(',')) {
				break;
			}

			this.consumeToken();
		}

		this.expect(Token.GroupClose, END);
		
		return params;
	}
	
	/**
	 * Parse the parameters being provided to a function call
	**/
	parseParameters(open: string): Node.Expression[] {
		const END = Character.toGroupClose(open);
		let args: any[] = [];
		
		if(this.match(Token.GroupClose, END)) {
			this.consumeToken();
		}
		else {
			args = this.parseCommaSeparatedClause(this.parseStatement);
			
			this.expect(Token.GroupClose, END);
		}
		
		return args;
	}
	
	parseObjectEntry(): Node.ObjectEntry {
		let
			tok = this.matchAny(Token.Identifier),
			key: Node.Expression, val: Node.Expression;
		
		if(tok) {
			this.consumeToken();
			
			key = new Node.Literal(tok.value);
			
			if(this.matchPunctuator(":")) {
				this.consumeToken();
				
				val = this.parseStatement();
			}
			else {
				val = new Node.Identifier(tok.value);
			}
		}
		else {
			key = this.parseStatement();
			
			this.expectPunctuator(":");
			
			val = this.parseStatement();
		}
		
		return new Node.ObjectEntry(key, val);
	}
	parseObjectLiteral(): Node.ObjectLiteral {
		let args: any[] = [];
		
		if(this.match(Token.GroupClose, "}")) {
			this.consumeToken();
		}
		else {
			args = this.parseCommaSeparatedClause(this.parseObjectEntry);
			this.expect(Token.GroupClose, "}");
		}
		
		return new Node.ObjectLiteral(args);
	}
	
	parseArrayLiteral(): Node.ArrayLiteral {
		let args: any[] = [];
		
		if(this.match(Token.GroupClose, ']')) {
			this.consumeToken();
		}
		else {
			args = this.parseCommaSeparatedClause(this.parseStatement);
			this.expect(Token.GroupClose, ']');
		}
		
		return new Node.ArrayLiteral(args);
	}

	/**
	 * Espresso function names must be capable of supporting non-
	 *  identifiers for operator overloads.
	**/
	parseFunctionName(): Node.Identifier|null {
		let tok = this.nextToken();
		
		if(tok.type === Token.GroupOpen) {
			return null;
		}
		
		this.consumeToken();

		return new Node.Identifier(tok.value);
	}

	parseFunctionExpression(): Node.FunctionExpression {
		return new Node.FunctionExpression(
			this.parseFunctionName(),
			this.readParamDefs(),
			this.parseBlock()
		);
	}

	parseIfExpression(): Node.IfChain {
		let clauses: Node.IfClause[] = [];
		
		for(;;) {
			clauses.push(
				new Node.IfClause(
					this.expectGroup(),
					this.parseBlock()
				)
			);

			// This is fairly complicated, so I put it in a block of its own rather
			//  than in the while test
			if(this.matchKeyword('else')) {
				this.consumeToken();
				if(this.matchKeyword('if')) {
					this.consumeToken();
					continue;
				}
				else {
					return new Node.IfChain(clauses, this.parseElseClause());
				}
			}
			else {
				break;
			}
		}

		return new Node.IfChain(clauses, null);
	}

	parseVarBinding(): Node.VariableBinding {
		let
			name = this.expectIdentifier(),
			val: Node.Expression | null = null;

		if(this.matchPunctuator('=')) {
			this.consumeToken();

			val = this.parseStatement();
		}
		return new Node.VariableBinding(name, val);
	}

	parseVarDeclaration(kind: string): Node.VariableDeclaration {
		let
			v: Node.VariableBinding[] = [],
			bind: Node.VariableBinding;

		for(;;) {
			v.push(this.parseVarBinding());
			if(this.matchPunctuator(',')) {
				this.consumeToken();
				continue;
			}
			break;
		}

		return new Node.VariableDeclaration(v, kind);
	}

	parseWhileExpression(): Node.WhileExpression {
		return new Node.WhileExpression(
			this.expectGroup(),
			this.parseBlock()
		);
	}

	parseReturnExpression(): Node.ReturnExpression {
		return new Node.ReturnExpression(this.parseStatement());
	}
	
	parseNewExpression(): Node.NewExpression {
		// Simplification: proto assumed to be an atom
		let proto = this.parseAtom(), params: Node.Expression[] = [];
		
		let open = this.matchAny(Token.GroupOpen);
		if(open) {
			this.consumeToken();
			params = this.parseParameters(open.value);
		}
		
		return new Node.NewExpression(proto, params);
	}

	parseAtom() {
		let tok = this.nextToken(), val, op;

		this.consumeToken();

		switch(tok.type) {
			case Token.BooleanLiteral:
				return new Node.Literal(tok.value === 'true');
			case Token.NilLiteral:
				return new Node.Literal(null);
			case Token.NumericLiteral:
				return new Node.Literal(parseInt(tok.value));
			case Token.StringLiteral:
				return new Node.Literal(tok.value);

			case Token.Keyword:
				switch(tok.value) {
					case 'if': return this.parseIfExpression();
					case 'var': return this.parseVarDeclaration('var');
					case 'while': return this.parseWhileExpression();
					case 'let': return this.parseFunctionExpression();
					case 'return': return this.parseReturnExpression();
					case 'fail':
						return new Node.FailExpression(
							this.parseStatement()
						);
					case 'new': return this.parseNewExpression();
					case 'this': return new Node.ThisExpression();
					
					default:
						throw this.unexpectedToken(tok);
				}
			
			case Token.GroupOpen:
				return this.parseGroup(tok.value);
	
			case Token.Identifier:
				return new Node.Identifier(tok.value);
			
			case Token.Punctuator:
				op = UNARYOPS[tok.value];
				if(op) {
					return new Node.UnaryExpression(
						tok.value, this.parseExpression(op)
					)
				}
			//... Fallthrough
				
			default:
				throw this.unexpectedToken(tok);
		}
	}

	nextBinaryOperator(minprec: number) {
		let tok =
			this.matchAny(Token.Punctuator) ||
			this.matchAny(Token.GroupOpen);

		if(tok) {
			let op = BINARYOPS[tok.value];

			if(typeof op !== 'number' || op < minprec) {
				return null;
			}

			this.consumeToken();
			return {
				token: tok, prec: op,
				leftassoc: (RIGHTOPS.indexOf(tok.value) == -1) ? 1 : 0
			};
		}

		return null;
	}
	
	subparseCall(open: string, lhs: Node.Expression) {
		let params = this.parseParameters(open);
		
		if(lhs instanceof Node.AccessExpression) {
			return new Node.MethodCallExpression(
				open, lhs.left, lhs.right, params
			);
		}
		else {
			return new Node.CallExpression(
				open, lhs, params
			);
		}
	}

	subparseAccess(lhs: Node.Expression, nmp: number) {
		let id = this.matchAny(Token.Identifier), rhs;
		if(id) {
			this.consumeToken();
			rhs = new Node.Literal(id.value);
		}
		else {
			rhs = this.parseExpression(nmp);
		}
		
		return new Node.AccessExpression(lhs, rhs);
	}
	
	subparseAssign(lhs: Node.Expression, nmp: number) {
		if(lhs instanceof Node.Identifier) {
			return new Node.IdentAssignExpression(
				lhs, this.parseExpression(nmp)
			);
		}
		else if(lhs instanceof Node.AccessExpression) {
			return new Node.AccessAssignExpression(
				lhs.left, lhs.right,
				this.parseExpression(nmp)
			);
		}
		else if(lhs instanceof Node.CallExpression) {
			return new Node.CallAssignExpression(
				lhs.type, lhs.callee, lhs.args,
				this.parseExpression(nmp)
			);
		}
		else {
			throw new Error("rvalue in assignment lhs");
		}
	}

	parseExpression(minprec: number): Node.Expression {
		let lhs = this.parseAtom(), op;
		while(op = this.nextBinaryOperator(minprec)) {
			let
				tv = op.token.value,
				next_min_prec = op.prec + op.leftassoc;
			
			if(Character.isGroupOpen(tv)) {
				lhs = this.subparseCall(tv, lhs);
			}
			else if(tv === '.') {
				lhs = this.subparseAccess(lhs, next_min_prec);
			}
			else if(tv === '=') {
				lhs = this.subparseAssign(lhs, next_min_prec);
			}
			else {
				lhs = new Node.BinaryExpression(
					op.token.value, lhs,
					this.parseExpression(next_min_prec)
				);
			}
		}
		
		return lhs;
	}
	
	/**
	 * Expressions which are separated by semicolons.
	**/
	parseStatement(): Node.Expression {
		return this.parseExpression(COMPACT);
	}
	
	parseBlock(): Node.Expression {
		// Blocks can have curly braces around them which are normally
		//  parsed as object literals.
		let tok = this.matchAny(Token.GroupOpen)
		if(tok) {
			this.consumeToken();
			return this.parseGroup(tok.value, true);
		}
		
		return this.parseStatement();
	}

	parseScript(): Node.Group {
		// Consume the default EOF token
		this.consumeToken();

		let sub: Node.Expression[] = [];

		for(;;) {
			while(this.matchPunctuator(';')) {
				this.consumeToken();
			}
			if(this.eof()) {
				break;
			}

			sub.push(this.parseStatement());
		}

		return new Node.Group(sub);
	}
}
