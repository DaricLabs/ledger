import { z } from 'zod';

/** The answer of `GET /health`. */
export const healthResponseSchema = z.object({
  status: z
    .literal('ok')
    .meta({ description: 'Always `ok`. A process that cannot answer is not ok.' }),
});

export type HealthResponseDto = z.infer<typeof healthResponseSchema>;
