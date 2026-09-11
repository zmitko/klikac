// Jedno místo pro import celé makro vrstvy v main procesu a testech.
// V rendereru se stejné moduly načítají jako <script> do globálu KlikacMacro.
const keymap = require("./keymap");
const ast = require("./ast");
const lexer = require("./lexer");
const parser = require("./parser");
const simpleParser = require("./simpleParser");
const serialize = require("./serialize");
const compiler = require("./compiler");
const validator = require("./validator");
const runtime = require("./runtime");
const help = require("./help");

module.exports = {
  MACRO_TYPE: ast.MACRO_TYPE,
  LANG_VERSION: ast.LANG_VERSION,
  keymap,
  ast,
  lexer,
  parser,
  simpleParser,
  serialize,
  compiler,
  validator,
  runtime,
  help,
};
