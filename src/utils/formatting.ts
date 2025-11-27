/**
 * Message formatting utilities for consistent, LLM-friendly output.
 *
 * These utilities help create clear, scannable responses that are optimized
 * for both LLM understanding and human readability.
 */

/**
 * Summarize a list of items with preview and details sections.
 *
 * @param items - Array of items to summarize
 * @param formatPreview - Function to format a single-line preview of each item
 * @param options - Formatting options
 * @returns Formatted summary with preview list and optional details
 *
 * @example
 * const users = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
 * const summary = summarizeList(users, (u) => `${u.id}. ${u.name}`);
 * // Returns:
 * // ## List (2 items)
 * // 1. Alice
 * // 2. Bob
 */
export function summarizeList<T>(
  items: T[],
  formatPreview: (item: T) => string,
  options: {
    title?: string;
    maxPreview?: number;
    detailsFormatter?: (item: T) => string;
    maxDetails?: number;
  } = {},
): string {
  const {
    title = 'List',
    maxPreview = 100,
    detailsFormatter,
    maxDetails = 5,
  } = options;

  if (items.length === 0) {
    return `## ${title} (0 items)\n\nNo items found.`;
  }

  const parts: string[] = [];

  // Preview section
  const previewItems = items.slice(0, maxPreview);
  const hasMore = items.length > maxPreview;

  parts.push(`## ${title} (${items.length} items)`);
  parts.push('');
  parts.push(...previewItems.map(formatPreview));

  if (hasMore) {
    parts.push(`... and ${items.length - maxPreview} more`);
  }

  // Details section (optional)
  if (detailsFormatter && items.length > 0) {
    parts.push('');
    parts.push('## Details');
    parts.push('');

    const detailItems = items.slice(0, maxDetails);
    parts.push(...detailItems.map(detailsFormatter));

    if (items.length > maxDetails) {
      parts.push('');
      parts.push(
        `_Showing ${maxDetails} of ${items.length} items. Use pagination to see more._`,
      );
    }
  }

  return parts.join('\n');
}

/**
 * Summarize the results of a batch operation.
 *
 * @param results - Array of operation results
 * @param options - Formatting options
 * @returns Formatted batch summary with success/failure counts
 *
 * @example
 * const results = [
 *   { success: true, id: '1', message: 'Created user Alice' },
 *   { success: false, id: '2', message: 'User Bob already exists' },
 * ];
 * const summary = summarizeBatch(results, {
 *   operationName: 'Create Users',
 *   successFormatter: (r) => `✓ ${r.message}`,
 *   errorFormatter: (r) => `✗ ${r.message}`,
 * });
 */
export function summarizeBatch<T extends { success: boolean }>(
  results: T[],
  options: {
    operationName: string;
    successFormatter: (result: T) => string;
    errorFormatter: (result: T) => string;
  },
): string {
  const { operationName, successFormatter, errorFormatter } = options;

  const successes = results.filter((r) => r.success);
  const failures = results.filter((r) => !r.success);

  const parts: string[] = [];

  parts.push(`## ${operationName} Results`);
  parts.push('');
  parts.push(
    `**Summary**: ${successes.length} succeeded, ${failures.length} failed (${results.length} total)`,
  );

  if (successes.length > 0) {
    parts.push('');
    parts.push('### Successful Operations');
    parts.push('');
    parts.push(...successes.map(successFormatter));
  }

  if (failures.length > 0) {
    parts.push('');
    parts.push('### Failed Operations');
    parts.push('');
    parts.push(...failures.map(errorFormatter));
  }

  return parts.join('\n');
}

/**
 * Format a field change for before/after comparison.
 *
 * @param fieldName - Human-readable field name
 * @param before - Value before change
 * @param after - Value after change
 * @returns Formatted change description
 *
 * @example
 * formatFieldChange('Status', 'pending', 'completed')
 * // Returns: "Status: pending → completed"
 */
export function formatFieldChange(
  fieldName: string,
  before: string | number | boolean | null | undefined,
  after: string | number | boolean | null | undefined,
): string {
  const formatValue = (value: string | number | boolean | null | undefined): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    return String(value);
  };

  return `${fieldName}: ${formatValue(before)} → ${formatValue(after)}`;
}

/**
 * Create a structured markdown section with optional tags.
 *
 * @param content - Content to wrap
 * @param options - Section options
 * @returns Formatted section with tags
 *
 * @example
 * createSection('User details: Alice', { tag: 'user_info' })
 * // Returns:
 * // <ove tag="user_info">
 * // User details: Alice
 * // </ove>
 */
export function createSection(
  content: string,
  options: {
    tag?: string;
    indent?: number;
  } = {},
): string {
  const { tag, indent = 0 } = options;
  const indentation = ' '.repeat(indent);

  if (!tag) {
    return content
      .split('\n')
      .map((line) => indentation + line)
      .join('\n');
  }

  const lines: string[] = [];
  lines.push(`${indentation}<ove tag="${tag}">`);
  lines.push(
    ...content.split('\n').map((line) => indentation + (line ? `  ${line}` : line)),
  );
  lines.push(`${indentation}</ove>`);

  return lines.join('\n');
}

/**
 * Truncate text to a maximum length with ellipsis.
 *
 * @param text - Text to truncate
 * @param maxLength - Maximum length (default: 100)
 * @returns Truncated text
 */
export function truncate(text: string, maxLength = 100): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Format a list of key-value pairs as markdown.
 *
 * @param pairs - Object with key-value pairs
 * @returns Formatted markdown list
 *
 * @example
 * formatKeyValueList({ name: 'Alice', age: 30, role: 'Admin' })
 * // Returns:
 * // - **Name**: Alice
 * // - **Age**: 30
 * // - **Role**: Admin
 */
export function formatKeyValueList(
  pairs: Record<string, string | number | boolean | null | undefined>,
): string {
  return Object.entries(pairs)
    .filter(([_key, value]) => value !== null && value !== undefined)
    .map(([key, value]) => {
      const capitalizedKey = key.charAt(0).toUpperCase() + key.slice(1);
      return `- **${capitalizedKey}**: ${value}`;
    })
    .join('\n');
}
