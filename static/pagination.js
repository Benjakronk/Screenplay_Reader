// Shared screenplay/stage/radio pagination.
//
// Input:  { titlePage, tokens } from Fountain.parse(text).
// Output: { rules, titlePage, pages: [ Page ] }
//          Page = {
//            pageNumber:  number,           // first body page is 1
//            isTitlePage: boolean,          // separate first page if title-page block present
//            blocks:      [ Block ],
//          }
//          Block = {
//            kind:     'scene' | 'action' | 'character' | 'parenthetical' | 'dialogue'
//                    | 'transition' | 'section' | 'synopsis' | 'centered' | 'lyric'
//                    | 'more' | 'contd' | 'dual',
//            lines:    [string],            // pre-wrapped to fit column
//            indentIn: number,              // inches from page-content left edge
//            align:    'left' | 'right' | 'center',
//            bold, italic, underline: bool,
//            cue:      string | null,       // character name for MORE/CONT'D
//            left, right: [Block]           // when kind === 'dual'
//          }
//
// The same module drives the on-screen page view (HTML) and the PDF
// exporter (Python port — kept in lockstep). Indents are in INCHES so JS
// and Python agree on a single unit; HTML translates inches to CSS pixels
// at the user's zoom level.

(function (root) {
  'use strict';

  // ----- format rules -----
  // Industry-standard margins. Numbers in inches. action_width is the
  // wrappable width for action/scene/section/etc.; dialogue_width is the
  // narrower dialogue column.
  const SCREENPLAY = {
    name: 'screenplay',
    pageW: 8.5, pageH: 11.0,
    left: 1.5, right: 1.0, top: 1.0, bottom: 1.0,
    characterIndent: 3.7, parenIndent: 3.1, dialogueIndent: 2.5,
    dialogueWidth: 3.3, actionWidth: 6.0,
    transitionAlign: 'right',
    paginate: 'lines',
  };
  const STAGE = {
    name: 'stage',
    pageW: 8.5, pageH: 11.0,
    left: 1.25, right: 1.25, top: 1.0, bottom: 1.0,
    characterIndent: 1.25, parenIndent: 1.6, dialogueIndent: 1.6,
    dialogueWidth: 4.6, actionWidth: 6.0,
    transitionAlign: 'left',
    paginate: 'scene',
    sceneHeadings: 'forced',
  };
  const RADIO = {
    name: 'radio',
    pageW: 8.5, pageH: 11.0,
    left: 1.25, right: 1.0, top: 1.0, bottom: 1.0,
    characterIndent: 1.25, parenIndent: 1.6, dialogueIndent: 2.5,
    dialogueWidth: 4.0, actionWidth: 6.0,
    transitionAlign: 'left',
    paginate: 'scene',
    sceneHeadings: 'forced',
  };
  const RULES = { screenplay: SCREENPLAY, stage: STAGE, radio: RADIO };

  // WHICH SCENE HEADINGS A FORMAT KEEPS.
  //
  // 'all' (screenplay) keeps every one. 'forced' (stage, radio) keeps only a
  // heading the writer forced with a leading dot, and drops INT./EXT. slug
  // lines, because a stage or radio script organises by `#` sections rather
  // than screenplay slugs.
  //
  // DROPPED, NOT HIDDEN. Hiding it in CSS was the old approach and it went
  // wrong three ways at once: the PDF renders from the same blocks and had no
  // such rule, so it printed headings the screen did not; the paginator still
  // counted the invisible lines; and stage/radio break the page before every
  // scene, so an unseen heading forced an unexplained page break and left a gap
  // above it. Deciding once, here, is the only way the screen, the PDF and the
  // page breaks can agree.
  function keepsScene(rules, tok) {
    return rules.sceneHeadings !== 'forced' || !!tok.forced;
  }

  // 12pt Courier ≈ 10 chars per inch, 6 lines per inch.
  const CHARS_PER_INCH = 10;
  const LINES_PER_INCH = 6;

  function rulesForTitlePage(tp) {
    const name = String(tp && tp.format || 'screenplay').toLowerCase().trim();
    return RULES[name] || SCREENPLAY;
  }

  function widthChars(widthIn) {
    return Math.max(1, Math.floor(widthIn * CHARS_PER_INCH));
  }

  // ----- text wrapping -----
  // Wrap on word boundaries within widthChars columns. Preserves explicit \n.
  function wrapLines(text, widthCharsArg) {
    const out = [];
    const wc = widthCharsArg;
    for (const para of String(text || '').split('\n')) {
      if (!para) { out.push(''); continue; }
      const words = para.split(' ');
      let line = '';
      for (let w of words) {
        const candidate = line ? line + ' ' + w : w;
        if (candidate.length <= wc) {
          line = candidate;
        } else {
          if (line) out.push(line);
          while (w.length > wc) { out.push(w.slice(0, wc)); w = w.slice(wc); }
          line = w;
        }
      }
      if (line) out.push(line);
    }
    return out;
  }

  // WHO IS SPEAKING, as opposed to what the cue line says.
  //
  // "SARA", "SARA (CONT'D)" and "SARA (V.O.)" are one character written three
  // ways. The cue line prints as the writer typed it, but everything that asks
  // *which character is this* — the colour coding, the character list,
  // rehearsal mode, the (MORE)/(CONT'D) carried across a page break — has to
  // agree, or the same person gets two colours and rehearsal masks their own
  // lines. Chained modifiers ("SARA (V.O.) (CONT'D)") fold too.
  //
  // Kept in lockstep with character_key() in pagination.py.
  function characterKey(cue) {
    return String(cue || '')
      .replace(/\n/g, ' ')
      .replace(/(?:\s*\([^)]*\))+\s*$/, '')   // (CONT'D), (V.O.), (O.S.), chained
      .trim()
      .toUpperCase();
  }

  // ----- token → blocks -----
  function tokensToBlocks(tokens, rules) {
    const blocks = [];
    let dualBuf = null;
    let lastCharacter = null;

    function makeBlock(tok, characterForDialogue) {
      const t = tok.type;
      const text = tok.text || '';
      switch (t) {
        case 'scene':
          return {
            kind: 'scene', lines: wrapLines(text.toUpperCase(), widthChars(rules.actionWidth)),
            indentIn: 0, align: 'left', bold: true,
          };
        case 'action':
          return { kind: 'action', lines: wrapLines(text, widthChars(rules.actionWidth)), indentIn: 0, align: 'left' };
        case 'character': {
          const name = text.replace(/\n/g, ' ').trim();
          return {
            // lines is what PRINTS (the writer's own cue, modifiers and all);
            // cue is WHO IT IS, which is what everything else matches on.
            kind: 'character', lines: [name.toUpperCase()],
            indentIn: rules.characterIndent - rules.left, align: 'left',
            cue: characterKey(name),
            splittable: false,
          };
        }
        case 'parenthetical':
          return {
            kind: 'parenthetical',
            lines: wrapLines(text, widthChars(rules.dialogueWidth + 0.5)),
            indentIn: rules.parenIndent - rules.left, align: 'left', splittable: false,
          };
        case 'dialogue':
          return {
            kind: 'dialogue', lines: wrapLines(text, widthChars(rules.dialogueWidth)),
            indentIn: rules.dialogueIndent - rules.left, align: 'left',
            cue: characterForDialogue, splittable: true,
          };
        case 'transition':
          return {
            kind: 'transition', lines: [text.toUpperCase()],
            indentIn: 0, align: rules.transitionAlign, bold: false,
          };
        case 'section':
          return {
            kind: 'section', level: tok.level || 1,
            lines: wrapLines(text.toUpperCase(), widthChars(rules.actionWidth)),
            indentIn: 0, align: 'left', bold: true,
          };
        case 'synopsis':
          return {
            kind: 'synopsis',
            lines: wrapLines(text, widthChars(rules.actionWidth)),
            indentIn: 0, align: 'left', italic: true,
          };
        case 'centered':
          return { kind: 'centered', lines: [text], indentIn: 0, align: 'center' };
        case 'lyric':
          return {
            kind: 'lyric',
            lines: wrapLines(text, widthChars(rules.actionWidth)),
            indentIn: 0, align: 'left', italic: true,
          };
        case 'page-break':
          return { kind: 'page-break', lines: [], indentIn: 0, splittable: false };
        default:
          return { kind: 'action', lines: wrapLines(text, widthChars(rules.actionWidth)), indentIn: 0 };
      }
    }

    tokens.forEach((tok, idx) => {
      const t = tok.type;
      if (t === 'scene' && !keepsScene(rules, tok)) return;
      if (t === 'dual-dialogue-begin') {
        dualBuf = { left: [], right: [], side: 'left' };
        return;
      }
      if (t === 'dual-dialogue-end') {
        if (dualBuf) {
          blocks.push({ kind: 'dual', lines: [], indentIn: 0, left: dualBuf.left, right: dualBuf.right, splittable: false, tokIdx: idx });
        }
        dualBuf = null;
        return;
      }
      if (t === 'character') {
        lastCharacter = characterKey(tok.text);
        if (dualBuf && tok.dual) dualBuf.side = 'right';
      }
      const b = makeBlock(tok, lastCharacter);
      b.tokIdx = idx;
      if (dualBuf) dualBuf[dualBuf.side].push(b);
      else blocks.push(b);
    });
    return blocks;
  }

  // ----- pagination -----
  function blockLineCount(b) {
    if (b.kind === 'page-break') return 0;
    if (b.kind === 'dual') {
      const l = (b.left || []).reduce((a, x) => a + Math.max(1, x.lines.length) + 1, 0);
      const r = (b.right || []).reduce((a, x) => a + Math.max(1, x.lines.length) + 1, 0);
      return Math.max(l, r);
    }
    return Math.max(1, (b.lines || []).length);
  }

  function spaceBefore(b, firstOnPage) {
    if (firstOnPage) return 0;
    if (b.kind === 'scene' || b.kind === 'section' || b.kind === 'character' || b.kind === 'transition') return 1;
    return 0;
  }

  function spaceAfter(b) {
    // Inline-pairs cluster together (character/paren/dialogue stay tight).
    if (b.kind === 'character' || b.kind === 'parenthetical') return 0;
    if (b.kind === 'dialogue') return 0; // next character cue brings its own gap
    return 1;
  }

  // Maximum content lines per page = (pageH - top - bottom) * LINES_PER_INCH.
  function linesPerPage(rules) {
    return Math.floor((rules.pageH - rules.top - rules.bottom) * LINES_PER_INCH);
  }

  function paginate(blocks, rules) {
    const cap = linesPerPage(rules);
    const pages = [];
    let current = [];
    let used = 0;

    function flush() {
      if (current.length === 0) return;
      pages.push(current);
      current = [];
      used = 0;
    }

    function fits(n) { return used + n <= cap; }

    let i = 0;
    while (i < blocks.length) {
      const b = blocks[i];

      if (b.kind === 'page-break') {
        flush(); i++; continue;
      }

      // Stage/radio: break before every scene (except the first on a page).
      if (rules.paginate === 'scene' && b.kind === 'scene' && current.length > 0) {
        flush();
      }

      const first = current.length === 0;
      const sb = spaceBefore(b, first);
      const lines = blockLineCount(b);

      // Keep character cue with at least one line of its dialogue.
      let glueLines = 0;
      if (b.kind === 'character' && i + 1 < blocks.length) {
        const nxt = blocks[i + 1];
        if (nxt.kind === 'parenthetical' || nxt.kind === 'dialogue') {
          glueLines = blockLineCount(nxt);
        }
      }

      const needed = sb + lines + glueLines;

      if (!fits(needed) && !first) {
        // Try splitting dialogue with MORE/CONT'D.
        if (b.kind === 'dialogue' && b.splittable !== false) {
          const room = cap - used - sb - 1; // leave a line for (MORE)
          if (room >= 2) {
            const head = { ...b, lines: b.lines.slice(0, room) };
            const tail = { ...b, lines: b.lines.slice(room) };
            current.push(head);
            current.push({ kind: 'more', lines: ['(MORE)'], indentIn: rules.characterIndent - rules.left, align: 'left', splittable: false });
            used += head.lines.length + 1;
            flush();
            if (b.cue) {
              current.push({
                kind: 'contd', lines: [b.cue + " (CONT'D)"],
                indentIn: rules.characterIndent - rules.left, align: 'left',
                cue: b.cue, splittable: false,
              });
              used += 1;
            }
            current.push(tail);
            used += tail.lines.length + spaceAfter(tail);
            i++;
            continue;
          }
        }
        flush();
        // Recompute spaceBefore on new page.
        const sb2 = spaceBefore(b, true);
        used = sb2;
      } else {
        used += sb;
      }

      current.push(b);
      used += lines + spaceAfter(b);
      i++;
    }
    flush();
    return pages;
  }

  function paginateScript(parsed) {
    const tp = parsed.titlePage || {};
    const rules = rulesForTitlePage(tp);
    const blocks = tokensToBlocks(parsed.tokens || [], rules);
    const pages = paginate(blocks, rules).map((blocks, i) => ({
      blocks,
      pageNumber: i + 1,
      isTitlePage: false,
    }));
    const hasTitle = Object.keys(tp).length > 0;
    if (hasTitle) {
      pages.unshift({ blocks: [], pageNumber: 0, isTitlePage: true, titlePage: tp });
    }
    return { rules, titlePage: tp, pages };
  }

  const api = { paginateScript, tokensToBlocks, paginate, RULES, wrapLines, characterKey,
                CHARS_PER_INCH, LINES_PER_INCH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.Pagination = api;
})(typeof window !== 'undefined' ? window : globalThis);
