// Keep the percentage visible even when a provider also supplies request counts.
export function usedText(item) {
  if (item.unlimited) return ''
  const percent = item.usedPercent === null ? '' : `${Math.round(item.usedPercent)}% used`
  return [percent, item.detail].filter(Boolean).join(' · ')
}
