/// Which of a host frame's messages a change should deliver.
///
/// The messages a frame is given are a document's input, in order: the
/// handshake, then whatever the host feeds it. On load the page gets all of
/// them. When the list changes afterwards the page is already running, and
/// what it is owed is what changed — a state feed whose value moved, or a
/// `refresh` appended behind an `init` it already acted on — and never the
/// entries it was handed before, which for a credential would mean
/// connecting twice.
library;

import 'dart:convert';

List<Map<String, Object?>> hostFrameChangedMessagesV1(
  List<Map<String, Object?>> before,
  List<Map<String, Object?>> after,
) => [
  for (var index = 0; index < after.length; index += 1)
    if (index >= before.length ||
        jsonEncode(before[index]) != jsonEncode(after[index]))
      after[index],
];
