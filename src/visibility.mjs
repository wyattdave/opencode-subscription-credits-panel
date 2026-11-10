export function setProviderVisible(hidden, id, visible) {
  const next = hidden.filter((value) => value !== id)
  return visible ? next : [...next, id]
}

export function visibleProviders(providers, hidden) {
  return providers.filter((provider) => !hidden.includes(provider.id))
}
