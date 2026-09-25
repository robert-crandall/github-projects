import { z } from 'zod';

// Bump when assessment meaning, canonical inputs, or either prompt changes.
export const ASSESSMENT_VERSION = 'work-assessment-v2';
export const ASSESSMENT_MAX_AGE = 24 * 60 * 60 * 1000;
const time = z.iso.datetime();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1).max(400);
export const assessmentSchema = z.strictObject({
  importance: text, urgency: text, blockers: text,
  supportingEvidence: z.array(z.strictObject({
    reference: z.string().min(1).max(500), summary: z.string().trim().min(1).max(240),
  })).min(1).max(8),
  uncertainty: z.string().max(400),
  reevaluateAt: time,
});
export const savedAssessmentSchema = z.strictObject({
  resultId: z.uuid(), id: z.string().min(1).max(500), profileId: z.string().min(1).max(100),
  fingerprint: hash, instructionsFingerprint: hash,
  assessmentVersion: z.string().min(1).max(100), model: z.string().max(100),
  evaluatedAt: time, assessment: assessmentSchema,
});
export const workAssessOutputSchema = z.strictObject({
  assessments: z.array(savedAssessmentSchema).min(1).max(20),
});
export const storedAssessmentSchema = savedAssessmentSchema.extend({
  sequence: z.number().int().positive().safe(),
});
export const assessmentPageSchema = z.strictObject({
  assessments: z.array(storedAssessmentSchema).max(20),
  before: z.number().int().positive().safe().nullable(),
});
export const assessmentAppendSchema = z.array(storedAssessmentSchema).min(1).max(20);
export type Assessment = z.infer<typeof assessmentSchema>;
export type SavedAssessment = z.infer<typeof savedAssessmentSchema>;
export type TaskAssessment = z.infer<typeof storedAssessmentSchema>;

export async function identityDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
