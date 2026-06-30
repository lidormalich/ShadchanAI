import { z } from 'zod';

const ObjectIdString = z.string().regex(/^[a-f\d]{24}$/i);

export const PairReviewParamsSchema = z.object({
  internalId: ObjectIdString,
  externalId: ObjectIdString,
});

export const InternalIdParamSchema = z.object({
  internalId: ObjectIdString,
});

export const PairReviewStatusEnum = z.enum([
  'suitable',
  'not_suitable',
  'review_later',
  'forced',
  'rejected_after_contact',
]);

// Body for upsert: status + optional reasons. We DEMAND a reason for
// 'not_suitable' and 'rejected_after_contact' because those are
// destructive operator judgments that need to be auditable.
export const UpsertPairReviewSchema = z
  .object({
    manualStatus: PairReviewStatusEnum,
    operatorReason: z.string().trim().max(1000).optional(),
    outcomeReason: z.string().trim().max(1000).optional(),
    matchSuggestionId: ObjectIdString.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.manualStatus === 'not_suitable' && !data.operatorReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operatorReason'],
        message: 'operatorReason is required when manualStatus is not_suitable',
      });
    }
    if (data.manualStatus === 'rejected_after_contact' && !data.outcomeReason?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeReason'],
        message: 'outcomeReason is required when manualStatus is rejected_after_contact',
      });
    }
  });

export type UpsertPairReviewBody = z.infer<typeof UpsertPairReviewSchema>;
