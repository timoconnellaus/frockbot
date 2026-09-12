/// Assistant text is Markdown.
///
/// The web client hands the string to a parser and injects the HTML. There is
/// no HTML here, so this walks the source once and builds spans and blocks
/// directly — which is also why it needs no sanitizer: nothing an author writes
/// can become anything but text, a link, or one of the blocks below.
///
/// The same subset the web client renders: headings, paragraphs, bullet and
/// ordered lists, fenced and indented code, block quotes, rules, and inline
/// emphasis, code, links and images-as-links. Single newlines are meaningful
/// the way chat clients treat them.
library;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

/// Renders [text] as a column of blocks. [onOpenLink] is given every link the
/// person taps; a null handler draws links as ordinary emphasis, because a
/// link that cannot be followed should not look like one.
class ShellMarkdown extends StatefulWidget {
  final String text;
  final void Function(String url)? onOpenLink;
  final TextStyle? style;
  const ShellMarkdown({
    super.key,
    required this.text,
    this.onOpenLink,
    this.style,
  });

  @override
  State<ShellMarkdown> createState() => _ShellMarkdownState();
}

class _ShellMarkdownState extends State<ShellMarkdown> {
  final _recognizers = <TapGestureRecognizer>[];

  @override
  void dispose() {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    for (final recognizer in _recognizers) {
      recognizer.dispose();
    }
    _recognizers.clear();
    final theme = Theme.of(context);
    final base =
        widget.style ??
        theme.textTheme.bodyLarge!.copyWith(fontWeight: FontWeight.w400);
    final blocks = parseMarkdownBlocks(widget.text);
    final children = <Widget>[];
    for (final block in blocks) {
      if (children.isNotEmpty) children.add(const SizedBox(height: 8));
      children.add(_block(context, block, base));
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: children,
    );
  }

  Widget _block(BuildContext context, MarkdownBlock block, TextStyle base) {
    final theme = Theme.of(context);
    switch (block.kind) {
      case MarkdownBlockKind.heading:
        final sizes = [1.5, 1.28, 1.12, 1.0];
        return Text.rich(
          _inline(block.text, base),
          style: base.copyWith(
            fontSize: base.fontSize! * sizes[(block.level - 1).clamp(0, 3)],
            fontWeight: FontWeight.w600,
            height: 1.25,
            color: block.level >= 4 ? theme.colorScheme.onSurfaceVariant : null,
          ),
        );
      case MarkdownBlockKind.code:
        return Container(
          width: double.infinity,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            border: Border.all(color: theme.colorScheme.outlineVariant),
            borderRadius: BorderRadius.circular(10),
          ),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(
              block.text,
              style: base.copyWith(
                fontFamily: 'monospace',
                fontFamilyFallback: const ['Menlo', 'Roboto Mono'],
                fontSize: base.fontSize! * 0.86,
                height: 1.35,
              ),
            ),
          ),
        );
      case MarkdownBlockKind.quote:
        return Container(
          padding: const EdgeInsets.only(left: 12),
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(color: theme.colorScheme.outline, width: 2),
            ),
          ),
          child: Text.rich(
            _inline(block.text, base),
            style: base.copyWith(color: theme.colorScheme.onSurfaceVariant),
          ),
        );
      case MarkdownBlockKind.rule:
        return Divider(color: theme.colorScheme.outlineVariant, height: 1);
      case MarkdownBlockKind.listItem:
        return Padding(
          padding: EdgeInsets.only(left: 4.0 + block.level * 16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 22,
                child: Text(
                  block.marker ?? '•',
                  style: base.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
              ),
              Expanded(
                child: Text.rich(_inline(block.text, base), style: base),
              ),
            ],
          ),
        );
      case MarkdownBlockKind.paragraph:
        return Text.rich(_inline(block.text, base), style: base);
    }
  }

  TextSpan _inline(String source, TextStyle base) {
    final theme = Theme.of(context);
    final spans = <InlineSpan>[];
    for (final run in parseMarkdownInline(source)) {
      var style = base;
      if (run.bold) style = style.copyWith(fontWeight: FontWeight.w600);
      if (run.italic) style = style.copyWith(fontStyle: FontStyle.italic);
      if (run.code) {
        style = style.copyWith(
          fontFamily: 'monospace',
          fontFamilyFallback: const ['Menlo', 'Roboto Mono'],
          fontSize: base.fontSize! * 0.9,
          backgroundColor: theme.colorScheme.surfaceContainerHighest,
        );
      }
      final href = run.href;
      if (href != null && widget.onOpenLink != null) {
        final recognizer = TapGestureRecognizer()
          ..onTap = () => widget.onOpenLink!(href);
        _recognizers.add(recognizer);
        spans.add(
          TextSpan(
            text: run.text,
            recognizer: recognizer,
            style: style.copyWith(
              color: theme.colorScheme.primary,
              decoration: TextDecoration.underline,
              decorationColor: theme.colorScheme.primary,
            ),
          ),
        );
        continue;
      }
      spans.add(TextSpan(text: run.text, style: style));
    }
    return TextSpan(children: spans);
  }
}

// ------------------------------------------------------------- the parser

enum MarkdownBlockKind { paragraph, heading, listItem, code, quote, rule }

class MarkdownBlock {
  final MarkdownBlockKind kind;
  final String text;

  /// Heading level, or list nesting depth.
  final int level;
  final String? marker;
  const MarkdownBlock(this.kind, this.text, {this.level = 0, this.marker});
}

final _fence = RegExp(r'^\s*(```|~~~)');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _bullet = RegExp(r'^(\s*)([-*+])\s+(.*)$');
final _ordered = RegExp(r'^(\s*)(\d{1,9})[.)]\s+(.*)$');
final _rule = RegExp(r'^\s*([-*_])(\s*\1){2,}\s*$');
final _quote = RegExp(r'^\s*>\s?(.*)$');

/// Splits the source into blocks. Blank lines separate paragraphs; a single
/// newline inside one is kept, the way a chat client treats it.
List<MarkdownBlock> parseMarkdownBlocks(String source) {
  final blocks = <MarkdownBlock>[];
  final lines = source.replaceAll('\r\n', '\n').split('\n');
  final paragraph = <String>[];
  final quoted = <String>[];
  void flushParagraph() {
    if (paragraph.isEmpty) return;
    blocks.add(
      MarkdownBlock(MarkdownBlockKind.paragraph, paragraph.join('\n')),
    );
    paragraph.clear();
  }

  void flushQuote() {
    if (quoted.isEmpty) return;
    blocks.add(MarkdownBlock(MarkdownBlockKind.quote, quoted.join('\n')));
    quoted.clear();
  }

  for (var index = 0; index < lines.length; index++) {
    final line = lines[index];
    if (_fence.hasMatch(line)) {
      flushParagraph();
      flushQuote();
      final code = <String>[];
      index++;
      while (index < lines.length && !_fence.hasMatch(lines[index])) {
        code.add(lines[index]);
        index++;
      }
      blocks.add(MarkdownBlock(MarkdownBlockKind.code, code.join('\n')));
      continue;
    }
    final quote = _quote.firstMatch(line);
    if (quote != null) {
      flushParagraph();
      quoted.add(quote.group(1)!);
      continue;
    }
    flushQuote();
    if (line.trim().isEmpty) {
      flushParagraph();
      continue;
    }
    if (_rule.hasMatch(line)) {
      flushParagraph();
      blocks.add(const MarkdownBlock(MarkdownBlockKind.rule, ''));
      continue;
    }
    final heading = _heading.firstMatch(line);
    if (heading != null) {
      flushParagraph();
      blocks.add(
        MarkdownBlock(
          MarkdownBlockKind.heading,
          heading.group(2)!,
          level: heading.group(1)!.length,
        ),
      );
      continue;
    }
    final bullet = _bullet.firstMatch(line);
    if (bullet != null) {
      flushParagraph();
      blocks.add(
        MarkdownBlock(
          MarkdownBlockKind.listItem,
          bullet.group(3)!,
          level: bullet.group(1)!.length ~/ 2,
          marker: '•',
        ),
      );
      continue;
    }
    final ordered = _ordered.firstMatch(line);
    if (ordered != null) {
      flushParagraph();
      blocks.add(
        MarkdownBlock(
          MarkdownBlockKind.listItem,
          ordered.group(3)!,
          level: ordered.group(1)!.length ~/ 2,
          marker: '${ordered.group(2)}.',
        ),
      );
      continue;
    }
    paragraph.add(line);
  }
  flushParagraph();
  flushQuote();
  return blocks;
}

/// One stretch of inline text with the emphasis that applies to it.
class MarkdownRun {
  final String text;
  final bool bold;
  final bool italic;
  final bool code;
  final String? href;
  const MarkdownRun(
    this.text, {
    this.bold = false,
    this.italic = false,
    this.code = false,
    this.href,
  });
}

final _inlinePattern = RegExp(
  r'`([^`]+)`'
  r'|!?\[([^\]]*)\]\(([^)\s]+)[^)]*\)'
  r'|\*\*([^*]+)\*\*'
  r'|__([^_]+)__'
  r'|\*([^*]+)\*'
  r'|_([^_]+)_'
  r'|(https?://[^\s<>)\]]+)',
);

/// Splits one block's text into styled runs. Code wins over emphasis, so a
/// path or a glob inside backticks survives verbatim.
List<MarkdownRun> parseMarkdownInline(String source) {
  final runs = <MarkdownRun>[];
  var cursor = 0;
  for (final match in _inlinePattern.allMatches(source)) {
    if (match.start > cursor) {
      runs.add(MarkdownRun(source.substring(cursor, match.start)));
    }
    cursor = match.end;
    if (match.group(1) != null) {
      runs.add(MarkdownRun(match.group(1)!, code: true));
    } else if (match.group(3) != null) {
      final label = match.group(2)!;
      runs.add(
        MarkdownRun(
          label.isEmpty ? match.group(3)! : label,
          href: match.group(3),
        ),
      );
    } else if (match.group(4) != null || match.group(5) != null) {
      runs.add(MarkdownRun(match.group(4) ?? match.group(5)!, bold: true));
    } else if (match.group(6) != null || match.group(7) != null) {
      runs.add(MarkdownRun(match.group(6) ?? match.group(7)!, italic: true));
    } else if (match.group(8) != null) {
      runs.add(MarkdownRun(match.group(8)!, href: match.group(8)));
    }
  }
  if (cursor < source.length) runs.add(MarkdownRun(source.substring(cursor)));
  return runs;
}
