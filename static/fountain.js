// Fountain parser.
//
// Exports `Fountain.parse(text)` which returns `{ titlePage, tokens }`.
//
// titlePage: object of lowercased keys → string values (multi-line joined with \n).
// tokens:    flat array of { type, text, ... } in document order.
//
// Token types: scene, action, character, parenthetical, dialogue,
// dual-dialogue-begin, dual-dialogue-end, transition, section, synopsis,
// note, page-break, lyric, centered.
//
// Implementation follows the public Fountain spec
// (https://fountain.io/syntax). Two passes:
//   1. Preprocess: strip boneyards, normalize line endings, peel title page.
//   2. Classify: state-machine walk over remaining lines.
//
// Inline emphasis (*italic*, **bold**, ***bi***, _underline_) is left in the
// token text as-is; the renderer converts it to HTML so we don't have to
// commit to an output format here.

(function (root) {
  'use strict';

  const SCENE_PREFIX = /^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[\.\s]/i;
  const TRANSITION_RE = /^[^a-z]+TO:\s*$/;     // ALL CAPS, ends with TO:
  const FORCED_TRANSITION_RE = /^>\s*(.+?)\s*$/;
  const CENTERED_RE = /^>\s*(.+?)\s*<\s*$/;
  const SECTION_RE = /^(#{1,6})\s*(.+?)\s*$/;
  const SYNOPSIS_RE = /^=\s+(.+?)\s*$/;
  const PAGE_BREAK_RE = /^={3,}\s*$/;
  const LYRIC_RE = /^~\s?(.*)$/;
  const NOTE_INLINE_RE = /\[\[([^\]]*?)\]\]/g;
  const PARENTHETICAL_RE = /^\(.*\)$/;
  const FORCED_CHARACTER_RE = /^@(.+?)(\s*\^)?\s*$/;
  const FORCED_ACTION_RE = /^!(.*)$/;
  const FORCED_SCENE_RE = /^\.(?!\.)(.+?)\s*$/;
  // A character cue line: uppercase letters allowed plus digits, spaces, and
  // a handful of punctuation. Must contain at least one uppercase letter.
  // Optional trailing `^` marks dual dialogue. The letter classes include the
  // Norwegian uppercase letters Æ Ø Å so cues like ÅSTA / SØREN are recognized.
  const CHARACTER_RE = /^[A-ZÆØÅ0-9 .'\-]*[A-ZÆØÅ][A-ZÆØÅ0-9 .'\-]*(\s*\([^)]*\))?(\s*\^)?\s*$/;

  function hasLower(s) { return /[a-zæøå]/.test(s); }

  function stripBoneyard(text) {
    // /* ... */ blocks are removed entirely, including across line breaks.
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
  }

  function splitTitlePage(lines) {
    // Title page is at the top of the file. It's a block of `key: value`
    // pairs, optionally multi-line (continuation lines are indented). It
    // ends at the first blank line or a `===` page break.
    //
    // If the first non-blank line isn't a `key:` pair, there's no title page.
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return { titlePage: {}, bodyStart: 0 };
    if (!/^[A-Za-z][A-Za-z0-9 _\-]*:/.test(lines[i])) {
      return { titlePage: {}, bodyStart: 0 };
    }

    const titlePage = {};
    let currentKey = null;
    let end = i;
    for (; end < lines.length; end++) {
      const line = lines[end];
      if (line.trim() === '') break;
      const m = /^([A-Za-z][A-Za-z0-9 _\-]*):\s*(.*)$/.exec(line);
      if (m) {
        currentKey = m[1].toLowerCase().replace(/\s+/g, '_');
        const val = m[2];
        titlePage[currentKey] = val;
      } else if (currentKey && /^\s+/.test(line)) {
        // Indented continuation of previous key.
        const cont = line.replace(/^\s+/, '');
        titlePage[currentKey] = titlePage[currentKey]
          ? titlePage[currentKey] + '\n' + cont
          : cont;
      } else {
        // Not a key:value and not an indented continuation → end of title page.
        break;
      }
    }
    // Trim trailing whitespace per value.
    for (const k of Object.keys(titlePage)) {
      titlePage[k] = titlePage[k].replace(/\s+$/g, '');
    }
    // Skip the blank line(s) separating title page from body.
    while (end < lines.length && lines[end].trim() === '') end++;
    return { titlePage, bodyStart: end };
  }

  function extractNotes(text) {
    // Pull [[notes]] out of inline text. Returns { clean, notes: [string] }.
    const notes = [];
    const clean = text.replace(NOTE_INLINE_RE, (_, body) => {
      notes.push(body.trim());
      return '';
    });
    return { clean: clean.replace(/\s+$/g, ''), notes };
  }

  function isBlank(line) { return line === undefined || line.trim() === ''; }

  function classify(lines, bodyStart) {
    const tokens = [];
    // Track whether we're inside a dual-dialogue pair.
    let dualOpen = false;
    let lastCharacterIdx = -1; // index into tokens of the most recent character token

    let currentSrcLine = 0;
    const push = (tok) => {
      tok._blankBefore = blankSinceLastToken;
      if (tok.srcLine === undefined) tok.srcLine = currentSrcLine;
      blankSinceLastToken = false;
      tokens.push(tok);
      return tokens.length - 1;
    };

    const closeDual = () => {
      if (dualOpen) {
        push({ type: 'dual-dialogue-end' });
        dualOpen = false;
      }
    };

    let blankSinceLastToken = true; // start-of-doc counts as preceded by blank

    for (let i = bodyStart; i < lines.length; i++) {
      currentSrcLine = i;
      const raw = lines[i];
      const line = raw.replace(/\s+$/g, '');
      const prev = i > 0 ? lines[i - 1] : '';
      const next = i + 1 < lines.length ? lines[i + 1] : '';

      if (line === '') {
        blankSinceLastToken = true;
        continue;
      }

      // Page break: `===` (must be a line of only equals, 3+).
      if (PAGE_BREAK_RE.test(line)) {
        closeDual();
        push({ type: 'page-break' });
        continue;
      }

      // Section heading.
      const secM = SECTION_RE.exec(line);
      if (secM) {
        closeDual();
        push({ type: 'section', level: secM[1].length, text: secM[2] });
        continue;
      }

      // Synopsis (must be `= text`, not part of a page break).
      const synM = SYNOPSIS_RE.exec(line);
      if (synM && !PAGE_BREAK_RE.test(line)) {
        push({ type: 'synopsis', text: synM[1] });
        continue;
      }

      // Centered text: `> ... <`.
      const ctrM = CENTERED_RE.exec(line);
      if (ctrM) {
        closeDual();
        push({ type: 'centered', text: ctrM[1] });
        continue;
      }

      // Forced transition: `> SMASH CUT:` (anything that starts with > but
      // doesn't end with < — that's centered).
      const ftrM = FORCED_TRANSITION_RE.exec(line);
      if (ftrM && !line.endsWith('<')) {
        closeDual();
        push({ type: 'transition', text: ftrM[1] });
        continue;
      }

      // Forced scene heading: leading `.` (but not `..` which is action).
      //
      // `forced` is recorded because the two kinds are not interchangeable
      // downstream: stage and radio scripts organise by `#` sections and drop
      // screenplay INT./EXT. slugs, but a heading the writer forced with a dot
      // is an explicit instruction and is always kept.
      const fscM = FORCED_SCENE_RE.exec(line);
      if (fscM) {
        closeDual();
        push({ type: 'scene', text: fscM[1], forced: true });
        continue;
      }

      // Natural scene heading: INT/EXT/EST/etc. Must have blank line before
      // (start-of-doc counts) and blank line after.
      if (SCENE_PREFIX.test(line) && isBlank(prev) && isBlank(next)) {
        closeDual();
        push({ type: 'scene', text: line });
        continue;
      }

      // Natural transition: ALL CAPS ending in TO:, blank above and below.
      if (TRANSITION_RE.test(line) && !hasLower(line) && isBlank(prev) && isBlank(next)) {
        closeDual();
        push({ type: 'transition', text: line });
        continue;
      }

      // Lyric: line starts with `~`.
      const lyrM = LYRIC_RE.exec(line);
      if (lyrM) {
        push({ type: 'lyric', text: lyrM[1] });
        continue;
      }

      // Forced action: leading `!` strips the marker and the line is action.
      const facM = FORCED_ACTION_RE.exec(line);
      if (facM) {
        closeDual();
        const { clean, notes } = extractNotes(facM[1]);
        push({ type: 'action', text: clean, notes });
        continue;
      }

      // Forced character: leading `@` lets non-uppercase names be cues.
      const fchM = FORCED_CHARACTER_RE.exec(line);
      if (fchM && isBlank(prev) && !isBlank(next)) {
        const name = fchM[1].trim();
        const dual = !!fchM[2];
        if (dual) {
          // Convert preceding character/dialogue block into the left half
          // of a dual-dialogue pair (insert dual-dialogue-begin before it).
          openDualBefore(tokens);
          dualOpen = true;
        } else {
          closeDual();
        }
        lastCharacterIdx = push({ type: 'character', text: name, dual });
        continue;
      }

      // Natural character: ALL CAPS line with blank above and non-blank below.
      if (CHARACTER_RE.test(line) && !hasLower(line) && isBlank(prev) && !isBlank(next)) {
        // Strip optional dual-dialogue caret.
        let name = line;
        let dual = false;
        if (/\^\s*$/.test(name)) {
          dual = true;
          name = name.replace(/\^\s*$/, '').trim();
        }
        if (dual) {
          openDualBefore(tokens);
          dualOpen = true;
        } else {
          closeDual();
        }
        lastCharacterIdx = push({ type: 'character', text: name, dual });
        continue;
      }

      // If the most recent non-blank line led to a character token (no blank
      // line between), this line is parenthetical or dialogue.
      if (lastCharacterIdx >= 0 && tokens.length > 0) {
        const last = tokens[tokens.length - 1];
        const lastIsCueRelated = last.type === 'character'
          || last.type === 'parenthetical'
          || last.type === 'dialogue';
        if (lastIsCueRelated && !isBlank(prev)) {
          if (PARENTHETICAL_RE.test(line)) {
            push({ type: 'parenthetical', text: line });
            continue;
          }
          const { clean, notes } = extractNotes(line);
          push({ type: 'dialogue', text: clean, notes });
          continue;
        }
      }

      // Default: action.
      closeDual();
      const { clean, notes } = extractNotes(line);
      push({ type: 'action', text: clean, notes });
    }

    closeDual();
    // Merge consecutive action tokens that weren't separated by blank lines
    // into multi-line action blocks. We deliberately did NOT merge during
    // the main pass so the parenthetical/dialogue lookup above stays simple.
    return mergeAdjacentActions(lines, bodyStart, tokens);
  }

  function openDualBefore(tokens) {
    // Walk back from the end and insert `dual-dialogue-begin` before the
    // first character token of the *previous* block. This lets a writer mark
    // dual dialogue with `^` on the second cue without restructuring.
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].type === 'character') {
        tokens.splice(i, 0, { type: 'dual-dialogue-begin' });
        return;
      }
    }
    // No preceding character — emit anyway so renderer sees a balanced pair.
    tokens.push({ type: 'dual-dialogue-begin' });
  }

  function mergeAdjacentActions(lines, bodyStart, tokens) {
    // We need to look at the original line positions to know whether two
    // action tokens were separated by a blank line. Since the classifier
    // doesn't record source positions, re-walk in parallel.
    //
    // Cheap alternative: just join consecutive action tokens with '\n'. The
    // classifier already drops blank lines, so two adjacent action tokens in
    // the stream were necessarily on consecutive non-blank lines.
    const out = [];
    for (const tok of tokens) {
      const top = out[out.length - 1];
      if (tok.type === 'action' && top && top.type === 'action' && !tok._blankBefore) {
        top.text = top.text + '\n' + tok.text;
        if (tok.notes && tok.notes.length) {
          top.notes = (top.notes || []).concat(tok.notes);
        }
      } else {
        out.push(tok);
      }
    }
    // Strip the internal _blankBefore marker before returning.
    for (const t of out) delete t._blankBefore;
    return out;
  }

  function parse(text) {
    if (typeof text !== 'string') text = String(text || '');
    const normalized = stripBoneyard(text.replace(/\r\n?/g, '\n'));
    const lines = normalized.split('\n');
    const { titlePage, bodyStart } = splitTitlePage(lines);
    const tokens = classify(lines, bodyStart);
    return { titlePage, tokens };
  }

  // --- inline emphasis to HTML ---------------------------------------------
  //
  // Order matters: *** before ** before *, so the longest run wins. Underline
  // is _..._ (Fountain) — not Markdown italics. Escape HTML first.
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function inlineToHtml(s) {
    let out = escapeHtml(s);
    out = out.replace(/\*\*\*(\S(?:.*?\S)?)\*\*\*/g, '<strong><em>$1</em></strong>');
    out = out.replace(/\*\*(\S(?:.*?\S)?)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/\*(\S(?:.*?\S)?)\*/g, '<em>$1</em>');
    out = out.replace(/_(\S(?:.*?\S)?)_/g, '<u>$1</u>');
    return out;
  }

  // Same as inlineToHtml but markers are kept visible (wrapped in .mk spans
  // for dimmed styling). Used by the "show markup" toggle.
  function inlineToHtmlVisible(s) {
    let out = escapeHtml(s);
    out = out.replace(/(\*\*\*)(\S(?:.*?\S)?)(\*\*\*)/g, '<span class="mk">$1</span><strong><em>$2</em></strong><span class="mk">$3</span>');
    out = out.replace(/(\*\*)(\S(?:.*?\S)?)(\*\*)/g, '<span class="mk">$1</span><strong>$2</strong><span class="mk">$3</span>');
    out = out.replace(/(\*)(\S(?:.*?\S)?)(\*)/g, '<span class="mk">$1</span><em>$2</em><span class="mk">$3</span>');
    out = out.replace(/(_)(\S(?:.*?\S)?)(_)/g, '<span class="mk">$1</span><u>$2</u><span class="mk">$3</span>');
    return out;
  }

  const api = { parse, inlineToHtml, inlineToHtmlVisible, escapeHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Fountain = api;
})(typeof window !== 'undefined' ? window : globalThis);
