/**
 * The main header for tokenization.
**/
#ifndef ESPRESSO_TOKEN_HPP
#define ESPRESSO_TOKEN_HPP

#include "common.hpp"

namespace esp {

enum TokenType {
	TT_NONE, TT_ERROR,
	TT_NIL, TT_BOOL, TT_INT, TT_OP
};

#ifdef DEBUG
namespace debug {

inline std::string toString(TokenType v) {
	switch(v) {
		case TT_NONE: return "TT_NONE";
		case TT_ERROR: return "TT_ERROR";
		case TT_NIL: return "TT_NIL";
		case TT_BOOL: return "TT_BOOL";
		case TT_INT: return "TT_INT";
		case TT_OP: return "TT_OP";
	}
	return "TT_<UNK>";
}

}
#endif

enum Symbol {
	TK_NONE,
	TK_PLUS, TK_MINUS,
	
	TK_RETURN
};

#ifdef DEBUG
namespace debug {

inline std::string toString(Symbol v) {
	switch(v) {
		case TK_NONE: return "TK_NONE";
		case TK_PLUS: return "TK_PLUS";
		case TK_MINUS: return "TK_MINUS";
		case TK_RETURN: return "TK_RETURN";
	}
	
	return "TK_<UNK>";
}

}
#endif

struct Position {
	const char *code, *cur;
	int line, col, pos;
};

struct Token {
	TokenType type;
	Position origin;
	size_t length;
	
	union TokenValue {
		bool b;
		esp_int i;
		Symbol sym;
	} value;
	
	Token();
	Token(TokenType tt, Position ori, size_t len, bool v);
	Token(TokenType tt, Position ori, size_t len, int i);
	Token(TokenType tt, Position ori, size_t len, esp_int i);
	Token(TokenType tt, Position ori, size_t len, Symbol sym);
};

#ifdef DEBUG
namespace debug {

inline std::string toString(Token v) {
	std::string out = toString(v.type);
	switch(v.type) {
		case TT_NONE:
		case TT_ERROR:
		case TT_NIL:
			return out;
		
		case TT_BOOL:
			return out + '(' + toString(v.value.b) + ')';
		
		case TT_INT:
			return out + '(' + toString(v.value.i) + ')';
		
		case TT_OP:
			return out + '(' + toString(v.value.sym) + ')';
	}
	
	return out + "(<UNK>)";
}

}
#endif

struct Lexer {
	Position pos;
	Token lookahead;
	
	Lexer(const char* code);
	
	void advance();
	bool nextToken();
	bool consumeToken();
	
	bool matchChar(int c);
	int nextChar();
	void consumeChar();
	
	void ignoreSpace();
	
	bool nextOperator();
	bool nextNumber();
	bool nextIdent();
};

}

#endif
