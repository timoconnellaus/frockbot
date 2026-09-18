import 'dart:io';

void Function(String) createVoiceTimingSinkV1() {
  File? file;
  try {
    final directory = Directory.systemTemp.createTempSync(
      'frockbot-voice-timings-',
    );
    file = File('${directory.path}/events.jsonl');
  } on FileSystemException {
    // Diagnostics must never prevent a call from starting.
  }
  return (line) {
    // ignore: avoid_print -- metadata-only, opt-in diagnostics.
    print(line);
    try {
      file?.writeAsStringSync('$line\n', mode: FileMode.append);
    } on FileSystemException {
      file = null;
    }
  };
}
