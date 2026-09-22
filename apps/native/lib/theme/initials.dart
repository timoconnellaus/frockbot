/// At most two letters, from the first two words of a name, email or handle.
String personInitialsV1(String name) {
  final words = name
      .trim()
      .split(RegExp(r'[\s@._-]+'))
      .where((word) => word.isNotEmpty)
      .take(2);
  final letters = words.map((word) => word[0].toUpperCase()).join();
  return letters.isEmpty ? '?' : letters;
}
