/**
 * Caller-chosen text (a terminal title, a conversation title, a message body) as one JSON string
 * with no line break of any kind, so that nothing inside it can end a service-written header or
 * start a line that reads as the service's own. JSON leaves U+2028 and U+2029 raw (#442, #349).
 */
export const quotedLine = (text: string) =>
  JSON.stringify(text).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
