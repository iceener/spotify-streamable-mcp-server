/**
 * Common Zod schema patterns for reuse across tools.
 *
 * These schemas provide consistent validation and helpful error messages
 * for common parameter types.
 */

import { z } from 'zod';

/**
 * Pagination parameters for list operations.
 */
export const PaginationSchema = z.object({
  first: z
    .number()
    .int()
    .min(1, 'first must be at least 1')
    .max(100, 'first cannot exceed 100')
    .optional()
    .describe(
      'Maximum number of items to return (1-100). Defaults to 50. Use smaller values for faster responses.',
    ),
  after: z
    .string()
    .optional()
    .describe(
      'Cursor from previous response to get next page. Use the "endCursor" from pageInfo.',
    ),
});

/**
 * Common filters for list operations.
 */
export const BaseFilterSchema = z.object({
  search: z
    .string()
    .optional()
    .describe('Search term to filter results. Searches across multiple fields.'),
  createdAfter: z
    .string()
    .datetime()
    .optional()
    .describe('Return only items created after this ISO 8601 timestamp.'),
  createdBefore: z
    .string()
    .datetime()
    .optional()
    .describe('Return only items created before this ISO 8601 timestamp.'),
  sortBy: z
    .enum(['created', 'updated', 'name'])
    .optional()
    .describe('Field to sort results by.'),
  sortOrder: z
    .enum(['asc', 'desc'])
    .optional()
    .describe('Sort direction. Defaults to "desc" (newest first).'),
});

/**
 * Identifier schemas for common entity types.
 */
export const IdSchema = z
  .string()
  .min(1, 'ID cannot be empty')
  .describe('Unique identifier for the entity.');

export const IdsSchema = z
  .array(IdSchema)
  .min(1, 'Must provide at least one ID')
  .max(50, 'Cannot process more than 50 IDs at once')
  .describe('Array of unique identifiers.');

/**
 * Batch operation schemas.
 */
export const BatchCreateSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z
      .array(itemSchema)
      .min(1, 'Must provide at least one item')
      .max(25, 'Cannot create more than 25 items at once')
      .describe('Array of items to create.'),
    stopOnError: z
      .boolean()
      .optional()
      .describe(
        'Stop processing on first error? If false, continues with remaining items.',
      ),
  });

export const BatchUpdateSchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z
      .array(itemSchema)
      .min(1, 'Must provide at least one item')
      .max(25, 'Cannot update more than 25 items at once')
      .describe('Array of items to update.'),
    stopOnError: z
      .boolean()
      .optional()
      .describe(
        'Stop processing on first error? If false, continues with remaining items.',
      ),
  });

/**
 * Status and state enums.
 */
export const StatusSchema = z
  .enum(['active', 'inactive', 'archived'])
  .describe(
    'Status of the entity. "active" means currently in use, "inactive" means disabled, "archived" means permanently removed from active use.',
  );

/**
 * Priority schema with validation.
 */
export const PrioritySchema = z
  .number()
  .int()
  .min(0, 'Priority must be 0 or higher')
  .max(4, 'Priority cannot exceed 4')
  .describe(
    'Priority level: 0 = No priority, 1 = Urgent, 2 = High, 3 = Normal, 4 = Low',
  );

/**
 * Estimate schema (e.g., for story points or hours).
 */
export const EstimateSchema = z
  .number()
  .nonnegative('Estimate cannot be negative')
  .describe('Numeric estimate for effort, complexity, or duration.');

/**
 * Date range schema for filtering.
 */
export const DateRangeSchema = z.object({
  startDate: z
    .string()
    .datetime()
    .optional()
    .describe('Start of date range (ISO 8601).'),
  endDate: z.string().datetime().optional().describe('End of date range (ISO 8601).'),
});

/**
 * Output format preferences.
 */
export const OutputFormatSchema = z.object({
  includeMetadata: z
    .boolean()
    .optional()
    .describe('Include metadata fields like createdAt, updatedAt in response?'),
  fullDetails: z
    .boolean()
    .optional()
    .describe('Return full details for each item? If false, returns summary.'),
  format: z
    .enum(['markdown', 'json', 'compact'])
    .optional()
    .describe('Output format preference. Defaults to "markdown".'),
});

/**
 * Helper to create a strict schema that rejects unknown keys.
 */
export function strictSchema<T extends z.ZodRawShape>(shape: T): z.ZodObject<T> {
  return z.object(shape).strict({
    message:
      'Unknown parameters detected. Please check the tool schema for allowed parameters.',
  });
}

/**
 * Helper to add common error messages to any schema.
 */
export function withErrorMessage<T extends z.ZodTypeAny>(
  schema: T,
  message: string,
): T {
  return schema.describe(message) as T;
}
