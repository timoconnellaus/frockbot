/// The rich text family: prose, code and quotation.
///
/// `Markdown` is drawn by the very widget the transcript draws a Bot's
/// messages with (`shell/markdown.dart`), which is the point: a card's prose
/// and a Bot's prose are the same prose, in the same subset, with the same
/// sanitizing argument — the parser builds spans and blocks directly and
/// nothing an author writes can become anything but text, a link or a block.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:genui/genui.dart';

import '../../shell/markdown.dart';
import '../../theme/frock_theme.dart';
import 'common.dart';
import 'links.dart';

/// A body of Markdown, in the app's own subset.
final frockMarkdown = CatalogItem(
  name: 'Markdown',
  dataSchema: frockSchemaOf('Markdown'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    return BoundString(
      dataContext: itemContext.dataContext,
      value: data['text'],
      builder: (context, text) => ShellMarkdown(
        text: text ?? '',
        style: theme.textTheme.bodyMedium,
        onOpenLink: (url) => frockOpenLinkV1(url),
      ),
    );
  },
);

/// Code, a command, or a payload, with a control that copies it.
final frockCodeBlock = CatalogItem(
  name: 'CodeBlock',
  dataSchema: frockSchemaOf('CodeBlock'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    return BoundString(
      dataContext: itemContext.dataContext,
      value: data['code'],
      builder: (context, code) => FrockCodeBlockView(
        code: code ?? '',
        language: frockString(data['language']),
        caption: frockString(data['caption']),
      ),
    );
  },
);

class FrockCodeBlockView extends StatefulWidget {
  final String code;
  final String? language;
  final String? caption;
  const FrockCodeBlockView({
    super.key,
    required this.code,
    this.language,
    this.caption,
  });

  @override
  State<FrockCodeBlockView> createState() => _FrockCodeBlockViewState();
}

class _FrockCodeBlockViewState extends State<FrockCodeBlockView> {
  bool copied = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final mono = theme.textTheme.bodySmall?.copyWith(
      fontFamily: 'monospace',
      fontFamilyFallback: const ['Menlo', 'Consolas', 'Courier New'],
      height: 1.45,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          decoration: BoxDecoration(
            color: theme.colorScheme.surface.withValues(alpha: 0.75),
            borderRadius: BorderRadius.circular(FrockTheme.radiusControl),
            border: Border.all(color: FrockTheme.hairline(theme.colorScheme)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 6, 6, 0),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        widget.language ?? '',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.labelSmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () async {
                        await Clipboard.setData(
                          ClipboardData(text: widget.code),
                        );
                        if (mounted) setState(() => copied = true);
                      },
                      child: Text(copied ? 'Copied' : 'Copy'),
                    ),
                  ],
                ),
              ),
              // Code is the one thing on a card that must not be re-wrapped:
              // indentation is meaning, so a long line scrolls sideways rather
              // than folding into a shape that is no longer the code.
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 12),
                child: SelectableText(widget.code, style: mono),
              ),
            ],
          ),
        ),
        if (widget.caption != null)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              widget.caption!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
      ],
    );
  }
}

/// Something somebody else wrote, set apart from the card's own words.
final frockQuote = CatalogItem(
  name: 'Quote',
  dataSchema: frockSchemaOf('Quote'),
  widgetBuilder: (itemContext) {
    final data = (itemContext.data as Map).cast<String, Object?>();
    final theme = Theme.of(itemContext.buildContext);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(width: 2, color: theme.colorScheme.primary),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                FrockBoundText(
                  dataContext: itemContext.dataContext,
                  value: data['text'],
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontStyle: FontStyle.italic,
                  ),
                ),
                if (data['attribution'] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: FrockBoundText(
                      dataContext: itemContext.dataContext,
                      value: data['attribution'],
                      maxLines: 1,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  },
);

/// The family, in the order the catalog declares it.
final List<CatalogItem> frockRichTextItemsV1 = List.unmodifiable([
  frockMarkdown,
  frockCodeBlock,
  frockQuote,
]);
