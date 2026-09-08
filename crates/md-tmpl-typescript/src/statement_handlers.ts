/**
 * Statement tag handlers (`{% if %}`, `{% for %}`, `{% match %}`, etc.) for md-tmpl.
 */

import {
  type LineMapEntry,
  type Node,
  type IfBranch,
  type MatchArm,
} from "./ast.js";
import { TemplateSyntaxError } from "./errors.js";
import {
  COMMA,
  EQUALS,
  PIPE,
  QUOTE_DOUBLE,
  QUOTE_SINGLE,
  BRACKET_OPEN,
  PAREN_OPEN,
  PAREN_CLOSE,
  KW_FOR,
  KW_IF,
  KW_MATCH,
  KW_TMPL,
  KW_PANIC,
  KW_ELSE,
  KW_CASE,
  KW_ELIF,
  KW_END_FOR,
  KW_END_IF,
  KW_END_MATCH,
  KW_END_TMPL,
  TAG_FOR_PREFIX,
  TAG_IF_PREFIX,
  TAG_MATCH_PREFIX,
  TAG_INCLUDE_PREFIX,
  TAG_TMPL_PREFIX,
  TAG_PANIC_PREFIX,
  TAG_PANIC_PAREN_PREFIX,
  TAG_RAW_ASSIGN_PREFIX,
  TAG_ELIF_PREFIX,
  TAG_CASE_PREFIX,
  TAG_WITH_PREFIX,
  KW_RAW,
  KW_END_RAW,
  NODE_FOR,
  NODE_IF,
  NODE_MATCH,
  NODE_RAW,
  NODE_INCLUDE,
  NODE_TMPL,
  NODE_PANIC,
} from "./consts.js";
import { isValidPathPrefix } from "./frontmatter.js";
import { findBlockEnd, getLoc } from "./parser_utils.js";
import { parseBody, parseBlock, parseBlockWithClosing } from "./parser.js";

export function handleStatement(
  tag: string,
  input: string,
  afterTag: number,
  trimAfter: boolean,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  let bodyStart = afterTag;
  if (trimAfter) {
    // -%} strips all whitespace after the tag (through next newline)
    while (bodyStart < input.length && /\s/.test(input.charAt(bodyStart))) {
      bodyStart++;
    }
  }

  // For loop
  if (tag.startsWith(TAG_FOR_PREFIX)) {
    return handleFor(tag, input, bodyStart, lineMap, tagStart);
  }

  // If/elif/else
  if (tag.startsWith(TAG_IF_PREFIX)) {
    return handleIf(tag, input, bodyStart, lineMap, tagStart);
  }

  // Match
  if (tag.startsWith(TAG_MATCH_PREFIX)) {
    return handleMatch(tag, input, bodyStart, lineMap, tagStart);
  }

  // Raw block
  if (tag === KW_RAW || tag.startsWith(TAG_RAW_ASSIGN_PREFIX)) {
    return handleRaw(tag, input, bodyStart, lineMap, tagStart);
  }

  // Include
  if (tag.startsWith(TAG_INCLUDE_PREFIX)) {
    return handleInclude(tag, bodyStart, lineMap, tagStart);
  }

  // Inline template definition
  if (tag.startsWith(TAG_TMPL_PREFIX)) {
    return handleTmpl(tag, input, bodyStart, lineMap, tagStart);
  }

  // Panic statement
  if (
    tag.startsWith(TAG_PANIC_PAREN_PREFIX) ||
    tag.startsWith(TAG_PANIC_PREFIX) ||
    tag === KW_PANIC
  ) {
    return handlePanic(tag, bodyStart, lineMap, tagStart);
  }

  if (
    tag === KW_ELSE ||
    tag.startsWith(TAG_ELIF_PREFIX) ||
    tag === KW_END_IF ||
    tag === KW_END_FOR ||
    tag === KW_END_RAW ||
    tag === KW_END_MATCH ||
    tag === KW_END_TMPL ||
    tag.startsWith(TAG_CASE_PREFIX) ||
    tag === KW_CASE
  ) {
    throw new TemplateSyntaxError(
      `unexpected '{% ${tag} %}' without matching opening tag`,
    );
  }
  throw new TemplateSyntaxError(`unknown statement: '${tag}'`);
}

// ---------------------------------------------------------------------------
// Statement handlers
// ---------------------------------------------------------------------------

function handleFor(
  tag: string,
  input: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  const match = /^for\s+(\w+)\s+in\s+(.+)$/.exec(tag);
  if (!match?.[1] || !match[2]) {
    throw new TemplateSyntaxError(`invalid for loop: '${tag}'`);
  }

  const [body, endPos, closingTag] = parseBlockWithClosing(
    input,
    afterTag,
    [KW_END_FOR, KW_ELSE],
    lineMap,
    { keyword: KW_FOR, tagStart },
  );

  if (!closingTag || (closingTag !== KW_END_FOR && closingTag !== KW_ELSE)) {
    const loc = getLoc(tagStart, lineMap);
    throw new TemplateSyntaxError(
      "unclosed '{% for %}' block",
      loc?.line,
      loc?.column,
      loc?.snippet,
    );
  }

  let elseBody: Node[] | undefined;
  let finalPos = endPos;

  if (closingTag === KW_ELSE) {
    const [elBody, elEndPos] = parseBlock(
      input,
      endPos,
      [KW_END_FOR],
      lineMap,
      {
        keyword: KW_FOR,
        tagStart,
      },
    );
    elseBody = elBody;
    finalPos = elEndPos;
  }

  return [
    [
      {
        kind: NODE_FOR,
        binding: match[1],
        iterExpr: match[2].trim(),
        body,
        elseBody,
        loc: getLoc(tagStart, lineMap),
      },
    ],
    finalPos,
  ];
}

function handleIf(
  tag: string,
  input: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  const condition = tag.slice(3).trim();
  const branches: IfBranch[] = [];
  let elseBody: Node[] | undefined;

  let pos = afterTag;
  let currentCondition = condition;

  for (;;) {
    const [body, endPos, closingTag, closingContent] = parseBlockWithClosing(
      input,
      pos,
      [KW_END_IF, KW_ELIF, KW_ELSE],
      lineMap,
      { keyword: KW_IF, tagStart },
    );

    if (
      !closingTag ||
      (closingTag !== KW_END_IF &&
        closingTag !== KW_ELIF &&
        closingTag !== KW_ELSE)
    ) {
      const loc = getLoc(tagStart, lineMap);
      throw new TemplateSyntaxError(
        "unclosed '{% if %}' block",
        loc?.line,
        loc?.column,
        loc?.snippet,
      );
    }

    if (closingTag === KW_ELIF) {
      branches.push({ condition: currentCondition, body });
      // The condition is in closingContent (everything after "elif ")
      currentCondition = (closingContent ?? "").trim();
      pos = endPos;
    } else if (closingTag === KW_ELSE) {
      branches.push({ condition: currentCondition, body });
      const [elBody, elEndPos, elClosingTag] = parseBlockWithClosing(
        input,
        endPos,
        [KW_END_IF],
        lineMap,
        { keyword: KW_IF, tagStart },
      );
      if (elClosingTag !== KW_END_IF) {
        const loc = getLoc(tagStart, lineMap);
        throw new TemplateSyntaxError(
          "unclosed '{% if %}' block",
          loc?.line,
          loc?.column,
          loc?.snippet,
        );
      }
      elseBody = elBody;
      pos = elEndPos;
      break;
    } else {
      // /if
      branches.push({ condition: currentCondition, body });
      pos = endPos;
      break;
    }
  }

  return [
    [{ kind: NODE_IF, branches, elseBody, loc: getLoc(tagStart, lineMap) }],
    pos,
  ];
}

function handleMatch(
  tag: string,
  input: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  const tagContent = tag.slice(6).trim();
  if (!tagContent) {
    throw new TemplateSyntaxError("missing expression in {% match %}");
  }

  // Check for inline match: `match expr case Variant [| Variant] [&& guard]`
  const inlineMatch = /^(\S+)\s+case\s+(.+)$/.exec(tagContent);
  if (inlineMatch?.[1] && inlineMatch[2]) {
    const caseContent = inlineMatch[2].trim();

    // Split on && to separate variant(s) from guard condition
    let variantPart: string;
    let guardExpr: string | undefined;
    const guardIdx = caseContent.indexOf("&&");
    if (guardIdx !== -1) {
      variantPart = caseContent.slice(0, guardIdx).trim();
      guardExpr = caseContent.slice(guardIdx + 2).trim();
    } else {
      variantPart = caseContent;
    }

    // Parse variant name(s) (separated by |), preserving quotes
    const variants = variantPart
      .split(PIPE)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    const firstVariant = variants[0];
    if (firstVariant === undefined) {
      throw new TemplateSyntaxError(
        "match: empty variant name in inline match case",
      );
    }
    if (variants.includes("_")) {
      throw new TemplateSyntaxError(
        "match: wildcard '_' in {% case %} is not supported — use {% else %} for fallback",
      );
    }

    // Parse body, stopping at /match or else.
    const [body, endPos, closingTag] = parseBlockWithClosing(
      input,
      afterTag,
      [KW_END_MATCH, KW_ELSE],
      lineMap,
      { keyword: KW_MATCH, tagStart },
    );
    if (
      !closingTag ||
      (closingTag !== KW_END_MATCH && closingTag !== KW_ELSE)
    ) {
      const loc = getLoc(tagStart, lineMap);
      throw new TemplateSyntaxError(
        "unclosed '{% match %}' block",
        loc?.line,
        loc?.column,
        loc?.snippet,
      );
    }
    let elseArm: Node[] | undefined;
    let finalPos = endPos;
    if (closingTag === KW_ELSE) {
      const [elseBody, elseEndPos, elClosingTag] = parseBlockWithClosing(
        input,
        endPos,
        [KW_END_MATCH],
        lineMap,
        { keyword: KW_MATCH, tagStart },
      );
      if (elClosingTag !== KW_END_MATCH) {
        const loc = getLoc(tagStart, lineMap);
        throw new TemplateSyntaxError(
          "unclosed '{% match %}' block",
          loc?.line,
          loc?.column,
          loc?.snippet,
        );
      }
      elseArm = elseBody;
      finalPos = elseEndPos;
    }
    return [
      [
        {
          kind: NODE_MATCH,
          expr: inlineMatch[1],
          arms:
            guardExpr !== undefined
              ? [{ variants, body, guard: guardExpr }]
              : [],
          elseArm,
          inlineGuard:
            guardExpr === undefined
              ? { variant: firstVariant, body }
              : undefined,

          loc: getLoc(tagStart, lineMap),
        },
      ],
      finalPos,
    ];
  }

  const expr = tagContent;
  const arms: MatchArm[] = [];
  let elseArm: Node[] | undefined;
  let pos = afterTag;

  // Parse case arms
  for (;;) {
    const [body, endPos, closingTag, closingContent] = parseBlockWithClosing(
      input,
      pos,
      [KW_END_MATCH, KW_CASE, KW_ELSE],
      lineMap,
      { keyword: KW_MATCH, tagStart },
    );

    if (
      !closingTag ||
      (closingTag !== KW_END_MATCH &&
        closingTag !== KW_CASE &&
        closingTag !== KW_ELSE)
    ) {
      const loc = getLoc(tagStart, lineMap);
      throw new TemplateSyntaxError(
        "unclosed '{% match %}' block",
        loc?.line,
        loc?.column,
        loc?.snippet,
      );
    }

    if (closingTag === KW_CASE) {
      if (body.length > 0 || arms.length === 0) {
        // This is the body of the previous arm, or we're at the first arm
        if (arms.length > 0) {
          const lastArm = arms[arms.length - 1];
          if (lastArm !== undefined) {
            lastArm.body = body;
          }
        }
      }
      // Parse the case variants and optional guard
      const caseStr = (closingContent ?? "").trim();
      let casePart: string;
      let caseGuard: string | undefined;
      const caseGuardIdx = caseStr.indexOf("&&");
      if (caseGuardIdx !== -1) {
        casePart = caseStr.slice(0, caseGuardIdx).trim();
        caseGuard = caseStr.slice(caseGuardIdx + 2).trim();
      } else {
        casePart = caseStr;
      }
      const variants = casePart
        .split(PIPE)
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (variants.length === 0) {
        throw new TemplateSyntaxError(
          "match: empty variant name in {% case %}",
        );
      }
      if (variants.includes("_")) {
        throw new TemplateSyntaxError(
          "match: wildcard '_' in {% case %} is not supported — use {% else %} for fallback",
        );
      }
      arms.push({ variants, body: [], guard: caseGuard });
      pos = endPos;
    } else if (closingTag === KW_ELSE) {
      const lastArm = arms[arms.length - 1];
      if (lastArm !== undefined) {
        lastArm.body = body;
      }
      const [elseBody, elseEndPos, elClosingTag] = parseBlockWithClosing(
        input,
        endPos,
        [KW_END_MATCH],
        lineMap,
        { keyword: KW_MATCH, tagStart },
      );
      if (elClosingTag !== KW_END_MATCH) {
        const loc = getLoc(tagStart, lineMap);
        throw new TemplateSyntaxError(
          "unclosed '{% match %}' block",
          loc?.line,
          loc?.column,
          loc?.snippet,
        );
      }
      elseArm = elseBody;
      pos = elseEndPos;
      break;
    } else {
      // /match
      const lastArm = arms[arms.length - 1];
      if (lastArm !== undefined) {
        lastArm.body = body;
      }
      pos = endPos;
      break;
    }
  }

  if (arms.length === 0) {
    throw new TemplateSyntaxError("match: no {% case %} arms found");
  }

  return [
    [{ kind: NODE_MATCH, expr, arms, elseArm, loc: getLoc(tagStart, lineMap) }],
    pos,
  ];
}

function handleRaw(
  tag: string,
  input: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  let closeTag = KW_END_RAW;
  if (tag.startsWith(TAG_RAW_ASSIGN_PREFIX)) {
    const delim = tag.slice(4).trim();
    closeTag = `/${delim}`;
  }

  // Find the closing raw tag
  const closeStr = `{% ${closeTag} %}`;
  const closeStrTrimmed = `{%${closeTag}%}`;
  let endIdx = input.indexOf(closeStr, afterTag);
  if (endIdx === -1) {
    endIdx = input.indexOf(closeStrTrimmed, afterTag);
  }
  // Also try with blockquote prefix stripped
  if (endIdx === -1) {
    const lines = input.slice(afterTag).split("\n");
    let offset = afterTag;
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed === `> {% ${closeTag} %}` ||
        trimmed === `{% ${closeTag} %}`
      ) {
        endIdx = offset;
        break;
      }
      offset += line.length + 1;
    }
  }

  if (endIdx === -1) {
    const loc = getLoc(tagStart, lineMap);
    const keyword = tag.startsWith(TAG_RAW_ASSIGN_PREFIX) ? tag : KW_RAW;
    throw new TemplateSyntaxError(
      `unclosed '{% ${keyword} %}' block`,
      loc?.line,
      loc?.column,
      loc?.snippet,
    );
  }

  const rawText = input.slice(afterTag, endIdx);
  // Find end of closing tag
  const closeEnd = input.indexOf("%}", endIdx);
  const finalEnd = closeEnd === -1 ? endIdx : closeEnd + 2;

  return [
    [{ kind: NODE_RAW, text: rawText, loc: getLoc(tagStart, lineMap) }],
    finalEnd,
  ];
}

function handleInclude(
  tag: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  const rest = tag.slice(8).trim();

  // Parse: [name](path) with ... / for ...
  const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)(.*)$/.exec(rest);
  let name: string;
  let path: string | undefined;
  let remaining: string;

  if (linkMatch?.[1] && linkMatch[2]) {
    name = linkMatch[1];
    path = linkMatch[2].trim();
    if (!isValidPathPrefix(path)) {
      throw new TemplateSyntaxError(
        `include path must begin with './', '../', or '/': '${path}'`,
      );
    }
    remaining = (linkMatch[3] ?? "").trim();
  } else {
    // Bare name include (inline template)
    if (rest.startsWith(BRACKET_OPEN)) {
      throw new TemplateSyntaxError(
        `malformed include link or path: '${rest}'`,
      );
    }
    const parts = rest.split(/\s+/);
    name = parts[0] ?? rest;
    remaining = parts.slice(1).join(" ").trim();
  }

  const withMappings = new Map<string, string>();
  let forBinding: string | undefined;
  let forExpr: string | undefined;

  // Parse `for binding in expr`
  const forMatch = /^for\s+(\w+)\s+in\s+(\S+)(.*)$/.exec(remaining);
  if (forMatch?.[1] && forMatch[2]) {
    forBinding = forMatch[1];
    forExpr = forMatch[2];
    remaining = (forMatch[3] ?? "").trim();
  }

  // Parse `with key=val, key=val`
  if (remaining.startsWith(TAG_WITH_PREFIX)) {
    remaining = remaining.slice(5).trim();
  }
  if (remaining.length > 0) {
    const pairs = remaining.split(COMMA);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf(EQUALS);
      if (eqIdx !== -1) {
        const key = pair.slice(0, eqIdx).trim();
        const val = pair.slice(eqIdx + 1).trim();
        withMappings.set(key, val);
      }
    }
  }

  return [
    [
      {
        kind: NODE_INCLUDE,
        name,
        path,
        withMappings,
        forBinding,
        forExpr,
        loc: getLoc(tagStart, lineMap),
      },
    ],
    afterTag,
  ];
}

function handleTmpl(
  tag: string,
  input: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  const name = tag.slice(5).trim();
  const [, endPos, closingTag] = parseBlockWithClosing(
    input,
    afterTag,
    [KW_END_TMPL],
    lineMap,
    { keyword: KW_TMPL, tagStart },
  );
  if (closingTag !== KW_END_TMPL) {
    const loc = getLoc(tagStart, lineMap);
    throw new TemplateSyntaxError(
      "unclosed '{% tmpl %}' block",
      loc?.line,
      loc?.column,
      loc?.snippet,
    );
  }
  const source = input.slice(
    afterTag,
    findBlockEnd(input, afterTag, KW_END_TMPL),
  );
  return [
    [{ kind: NODE_TMPL, name, source, loc: getLoc(tagStart, lineMap) }],
    endPos,
  ];
}

function handlePanic(
  tag: string,
  afterTag: number,
  lineMap?: LineMapEntry[],
  tagStart?: number,
): [Node[], number] {
  let arg = tag.slice(5).trim();
  if (arg.startsWith(PAREN_OPEN)) {
    if (!arg.endsWith(PAREN_CLOSE)) {
      throw new TemplateSyntaxError("unclosed parenthesis in panic statement");
    }
    arg = arg.slice(1, -1).trim();
  }
  if (!arg) {
    throw new TemplateSyntaxError("panic statement requires an argument");
  }
  let bodySrc: string;
  if (
    (arg.startsWith(QUOTE_DOUBLE) && arg.endsWith(QUOTE_DOUBLE)) ||
    (arg.startsWith(QUOTE_SINGLE) && arg.endsWith(QUOTE_SINGLE))
  ) {
    bodySrc = arg.slice(1, -1);
  } else {
    bodySrc = `{{ ${arg} }}`;
  }
  const body = parseBody(bodySrc);
  return [
    [{ kind: NODE_PANIC, body, loc: getLoc(tagStart, lineMap) }],
    afterTag,
  ];
}
