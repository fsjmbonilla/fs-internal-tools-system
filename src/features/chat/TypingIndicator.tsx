export function TypingIndicator({ names }: { names: string[] }) {
  if (names.length === 0) return <div className="h-5" />;
  const text = names.length === 1 ? `${names[0]} is typing…` : `${names.join(', ')} are typing…`;
  return <div className="h-5 px-4 text-xs text-muted-foreground">{text}</div>;
}
