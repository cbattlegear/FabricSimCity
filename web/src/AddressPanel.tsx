import { useMemo, type ReactNode } from 'react'
import { SearchField } from './MapShell'
import { searchAddressBook, type AddressEntry, type AddressKind } from './addressBook'

/**
 * The city's address book: one searchable list of everywhere you can go.
 *
 * Query families, tables and infrastructure facilities are three different kinds of thing, but they
 * are all destinations on the same map, so they share one search box. Splitting them into three
 * lists would mean knowing which list a thing lives in before you could find it. They stay grouped
 * under headings so the kinds remain legible, and each entry shows its address, which is the whole
 * point of the panel — it tells you where the thing physically is.
 */

const ICONS: Readonly<Record<AddressKind, string>> = {
  query: '◈',
  table: '▤',
  facility: '⌂',
}

export function AddressBook({
  entries,
  term,
  onTermChange,
  selectedId,
  onSelect,
  footer,
}: {
  entries: readonly AddressEntry[]
  term: string
  onTermChange: (term: string) => void
  selectedId: string | null
  onSelect: (entry: AddressEntry) => void
  footer?: ReactNode
}) {
  const groups = useMemo(() => searchAddressBook(entries, term), [entries, term])
  const total = groups.reduce((sum, group) => sum + group.entries.length, 0)

  return (
    <>
      <div className="sidebar-search">
        <SearchField
          value={term}
          onChange={onTermChange}
          label="Search queries, tables and infrastructure"
          placeholder="Search queries, tables, infrastructure"
        />
      </div>

      <div className="sidebar-scroll">
        {total === 0 ? (
          <p className="address-empty">
            {entries.length === 0
              ? 'Nothing has been loaded for this database yet.'
              : `Nothing in this city matches “${term}”.`}
          </p>
        ) : (
          groups.map(group => (
            <section key={group.kind} className="address-group" aria-label={group.label}>
              <h2 className="address-group-heading">
                {group.label}
                <span>{group.entries.length}</span>
              </h2>
              <ul className="address-list">
                {group.entries.map(entry => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`address-entry ${entry.id === selectedId ? 'is-selected' : ''}`}
                      aria-pressed={entry.id === selectedId}
                      onClick={() => onSelect(entry)}
                    >
                      <span className={`address-icon is-${entry.kind}`} aria-hidden="true">{ICONS[entry.kind]}</span>
                      <span className="address-text">
                        <strong>{entry.name}</strong>
                        <span>{entry.meta}</span>
                        {/* An entry with no lot on the loaded page says so rather than inventing one. */}
                        <small>{entry.address ?? 'Not on the loaded page'}</small>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {footer}
    </>
  )
}
