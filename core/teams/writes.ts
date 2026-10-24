/**
 * Which roles change files. Only a builder does; a lead, a reviewer and a
 * tester run read-only, held there by the role fence (fence.ts). Pure and
 * browser-safe.
 */

/** The roles a session runs under: a goal's step roles. */
export type WriteRole = 'lead' | 'builder' | 'reviewer' | 'tester'

/** Only builders change files; reviewers and testers are fenced read-only. */
export const roleWrites = (role: WriteRole): boolean => role === 'builder'
