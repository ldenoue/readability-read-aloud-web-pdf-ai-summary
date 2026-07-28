import LinkifyIt from "linkify-it";

const linkify = new LinkifyIt();

export function linkMatches(text) {
  const matches = (linkify.match(text) || []).map((match) => ({
    start: match.index,
    end: match.lastIndex,
    label: match.raw,
    href: match.url,
    schema: match.schema,
  }));
  for (const match of text.matchAll(/\{([^{}]+)\}@((?:[a-z0-9-]+\.)+[a-z]{2,})/giu)) {
    const recipients = match[1].split(/\s*,\s*/u).filter(Boolean).map((name) => `${name}@${match[2]}`);
    if (recipients.length < 2) continue;
    matches.push({
      start: match.index,
      end: match.index + match[0].length,
      label: match[0],
      href: `mailto:${recipients.join(",")}`,
      schema: "mailto:",
    });
  }
  return matches.sort((left, right) => left.start - right.start || right.end - left.end)
    .filter((match, index, sorted) => !sorted.slice(0, index).some((earlier) => match.start < earlier.end));
}
