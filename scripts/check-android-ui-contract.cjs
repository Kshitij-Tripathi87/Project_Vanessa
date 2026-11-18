#!/usr/bin/env node
/**
 * Static guard for the Android instrumented UI journeys.
 *
 * The emulator job is expensive and slow, so a typo'd selector ("Settings
 * navigation") or a screen that stopped composing shared chrome (the navigation
 * bar) used to surface only 20+ minutes later as an emulator failure. This check
 * runs in seconds and fails when a UI test targets semantics that the Compose
 * sources never render.
 *
 * It is intentionally conservative: it verifies that each selector string is
 * either a literal in the main source set, or can be produced by a templated
 * content description (for example "$label navigation") whose arguments are
 * themselves literals in the app. It does not replace the emulator journey; it
 * just turns a missing selector into a fast, local failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const androidRoot = path.join(repoRoot, 'apps', 'android', 'app', 'src');
const testRoot = path.join(androidRoot, 'androidTest');
const mainRoot = path.join(androidRoot, 'main');

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const selectorPatterns = [
  { name: 'onNodeWithText', re: /onNodeWithText\(\s*"((?:[^"\\]|\\.)*)"/g },
  { name: 'onAllNodesWithText', re: /onAllNodesWithText\(\s*"((?:[^"\\]|\\.)*)"/g },
  { name: 'onNodeWithContentDescription', re: /onNodeWithContentDescription\(\s*"((?:[^"\\]|\\.)*)"/g },
  { name: 'onAllNodesWithContentDescription', re: /onAllNodesWithContentDescription\(\s*"((?:[^"\\]|\\.)*)"/g },
];

const mainSources = walk(mainRoot)
  .filter((file) => file.endsWith('.kt'))
  .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
for (const source of mainSources) source.masked = maskStrings(source.text);

const testSources = walk(testRoot).filter((file) => file.endsWith('.kt'));

// Entry points live outside the main source set (for example an Activity's
// setContent block), so they participate in the reachability roots.
const androidSources = walk(androidRoot)
  .filter((file) => file.endsWith('.kt'))
  .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));
for (const source of androidSources) source.masked = maskStrings(source.text);

/** String literals in the app source, used both directly and as template args. */
const mainLiterals = new Set();
for (const source of mainSources) {
  for (const match of source.text.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const literal = match[1];
    // Skip interpolated strings: their runtime value is not knowable here.
    if (literal.includes('$')) continue;
    mainLiterals.add(literal);
  }
}

/** Content descriptions built from a template, e.g. "$label navigation". */
const mainTemplates = [];
for (const source of mainSources) {
  for (const match of source.text.matchAll(/contentDescription\s*=\s*"([^"]*)"/g)) {
    if (match[1].includes('$')) mainTemplates.push(match[1]);
  }
}

/**
 * True when the app can produce this content description, either literally or
 * by substituting literals into a templated description.
 */
function isRenderedContentDescription(selector) {
  if (mainLiterals.has(selector)) return true;
  return mainTemplates.some((template) => {
    const pattern = template
      .split(/(\$[A-Za-z_][A-Za-z0-9_]*)/)
      .map((part) => (part.startsWith('$') ? '[\\s\\S]+?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    return new RegExp(`^${pattern}$`).test(selector);
  });
}

function isRenderedText(selector) {
  return mainLiterals.has(selector);
}

/**
 * Replaces string literal bodies with spaces so brace matching is not confused
 * by braces inside text. Length is preserved to keep offsets stable.
 */
function maskStrings(text) {
  return text.replace(/"((?:[^"\\]|\\.)*)"/g, (full) => '"' + ' '.repeat(full.length - 2) + '"');
}

/**
 * Indexes every composable declared in the main source set with its body range
 * and the number of call sites outside its own declaration.
 */
function indexComposables(sources) {
  const composables = [];
  for (const source of sources) {
    const masked = maskStrings(source.text);
    // Only composables render UI; plain helpers cannot supply a selector node.
    const declRe = /@Composable\s*(?:private|internal|public)?\s*fun\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let match;
    while ((match = declRe.exec(masked)) !== null) {
      const name = match[1];

      // Walk from the parameter list to the function's opening brace, so
      // default arguments and lambda parameters are not mistaken for the body.
      const paramsStart = masked.indexOf('(', match.index);
      let paramsEnd = paramsStart;
      let parens = 0;
      for (let i = paramsStart; i < masked.length; i += 1) {
        if (masked[i] === '(') parens += 1;
        else if (masked[i] === ')') {
          parens -= 1;
          if (parens === 0) {
            paramsEnd = i;
            break;
          }
        }
      }

      const openBrace = masked.indexOf('{', paramsEnd);
      if (openBrace === -1) continue;

      // An "=" between the parameter list and the brace means an expression
      // body, which has no block to scan for rendered literals.
      if (masked.slice(paramsEnd, openBrace).includes('=')) continue;

      let depth = 0;
      let end = -1;
      for (let i = openBrace; i < masked.length; i += 1) {
        if (masked[i] === '{') depth += 1;
        else if (masked[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) continue;

      composables.push({
        file: source.file,
        name,
        start: match.index,
        declarationIndex: match.index,
        bodyStart: openBrace,
        end,
      });
    }
  }

  for (const composable of composables) {
    let calls = 0;
    for (const source of sources) {
      // Mask strings so a name mentioned in UI copy is not counted as a call.
      const masked = maskStrings(source.text);
      for (const match of masked.matchAll(new RegExp(`\\b${composable.name}\\s*\\(`, 'g'))) {
        // Skip the "recursive" hits that are really the declaration itself or
        // calls nested inside this composable's own body.
        const isSelfDeclaration = source.file === composable.file && match.index === composable.declarationIndex;
        const isInsideOwnBody =
          source.file === composable.file &&
          match.index > composable.bodyStart &&
          match.index < composable.end;
        if (isSelfDeclaration || isInsideOwnBody) continue;
        calls += 1;
      }
    }
    composable.calls = calls;
  }

  return composables;
}

/**
 * A composable is reachable when another composable that is itself reachable
 * calls it. The root is any composable invoked from a non-composable file such
 * as an Activity's setContent block.
 */
function markReachable(composables, sources) {
  const byName = new Map();
  for (const composable of composables) {
    if (!byName.has(composable.name)) byName.set(composable.name, []);
    byName.get(composable.name).push(composable);
  }

  const edgeCache = new Map();
  function calleesOf(composable) {
    if (edgeCache.has(composable)) return edgeCache.get(composable);
    const source = sources.find((item) => item.file === composable.file);
    const body = source ? maskStrings(source.text).slice(composable.bodyStart, composable.end) : '';
    const callees = [];
    for (const name of byName.keys()) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) callees.push(name);
    }
    edgeCache.set(composable, callees);
    return callees;
  }

  const roots = [];
  for (const source of sources) {
    if (source.masked.includes('@Composable')) continue;
    const text = maskStrings(source.text);
    for (const name of byName.keys()) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(text)) roots.push(name);
    }
  }

  const reachableNames = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const composable of byName.get(name) || []) {
      for (const callee of calleesOf(composable)) {
        if (!reachableNames.has(callee)) {
          reachableNames.add(callee);
          queue.push(callee);
        }
      }
    }
  }

  for (const composable of composables) {
    composable.reachable = reachableNames.has(composable.name);
  }

  return composables;
}

const composables = markReachable(indexComposables(mainSources), androidSources);

/**
 * Composables whose body provides this selector. A selector is only reachable
 * when at least one provider is itself called somewhere: declared-but-unused UI
 * is exactly what shipped the unreachable "Settings navigation" tab.
 */
function providersOf(selector) {
  const providers = [];

  for (const composable of composables) {
    const source = mainSources.find((item) => item.file === composable.file);
    if (!source) continue;

    const body = source.text.slice(composable.bodyStart, composable.end);
    if (body.includes(`"${selector}"`)) {
      providers.push(composable);
      continue;
    }

    // Templated descriptions such as contentDescription = "$label navigation"
    // resolve to "<label> navigation" from the composable's own literal label.
    for (const template of body.matchAll(/contentDescription\s*=\s*"([^"]*)"/g)) {
      const shape = template[1];
      if (!shape.includes('$')) continue;

      // Rebuild the shape as a regex: literal text stays, the variable matches.
      const pattern = shape
        .split(/(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)/)
        .map((part) => (part.startsWith('$') ? '.+?' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('');
      if (new RegExp(`^${pattern}$`).test(selector)) {
        providers.push(composable);
        break;
      }
    }
  }

  return providers;
}

/** Text that the test itself types is not expected to be a source literal. */
function typedLiterals(text) {
  const typed = new Set();
  for (const match of text.matchAll(/performTextInput\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    typed.add(match[1]);
  }
  return typed;
}

/** Literals asserted to be absent must not be rendered. */
function isNegativeAssertion(text, index) {
  const statement = text.slice(index, index + 400).split('\n\n')[0];
  return /assertCountEquals\(0\)|assertDoesNotExist\(\)/.test(statement);
}

if (testSources.length === 0) {
  console.log('android-ui-contract: no instrumented UI sources found; nothing to check.');
  process.exit(0);
}

const missing = [];

for (const testFile of testSources) {
  const text = fs.readFileSync(testFile, 'utf8');
  const typed = typedLiterals(text);

  for (const { name, re } of selectorPatterns) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const selector = match[1];
      if (!selector) continue;

      // Interpolated or dynamically built selectors cannot be resolved
      // statically; skip them instead of reporting false positives.
      if (selector.includes('$') || selector.includes('{')) continue;
      if (typed.has(selector)) continue;
      if (isNegativeAssertion(text, match.index)) continue;

      const rendered = name.includes('ContentDescription')
        ? isRenderedContentDescription(selector)
        : isRenderedText(selector);

      if (!rendered) {
        missing.push({
          file: path.relative(repoRoot, testFile),
          line: text.slice(0, match.index).split('\n').length,
          selector,
          api: name,
          reason: 'the app source never renders this string',
        });
        continue;
      }

      // The string exists, but it may only live inside UI that nothing composes.
      const providers = providersOf(selector);
      if (providers.length > 0 && !providers.some((fn) => fn.reachable)) {
        missing.push({
          file: path.relative(repoRoot, testFile),
          line: text.slice(0, match.index).split('\n').length,
          selector,
          api: name,
          reason: `only rendered by ${providers
            .map((fn) => fn.name)
            .join(', ')}, which no reachable composable calls`,
        });
      }
    }
  }
}

if (missing.length > 0) {
  console.error('android-ui-contract: UI tests reference semantics the app never renders:');
  for (const item of missing) {
    console.error(`  ${item.file}:${item.line}  ${item.api}("${item.selector}")`);
    console.error(`      ${item.reason}`);
  }
  console.error(
    '\nFix the selector or render the element. Shared chrome such as the navigation bar ' +
      'must be composed by the app shell, not left as unused code.',
  );
  process.exit(1);
}

console.log(
  `android-ui-contract: ${testSources.length} UI test source(s) only target rendered semantics.`,
);
