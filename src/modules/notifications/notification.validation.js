import { z } from 'zod';

export const registerDeviceSchema = {
  body: z.object({
    token: z
      .string({ required_error: 'FCM device token is required' })
      .trim()
      .min(1, 'FCM device token cannot be empty')
      .max(2048, 'FCM device token exceeds maximum allowable length'),
    platform: z
      .enum(['WEB', 'IOS', 'ANDROID'], {
        errorMap: () => ({ message: "Platform must be one of 'WEB', 'IOS', or 'ANDROID'" }),
      })
      .default('WEB'),
    userAgent: z.string().max(500).optional(),
  }),
};

export const unregisterDeviceSchema = {
  body: z.object({
    token: z
      .string({ required_error: 'FCM device token is required' })
      .trim()
      .min(1, 'FCM device token cannot be empty'),
  }),
};

export const listNotificationsSchema = {
  query: z.object({
    page: z.coerce.number().int().min(1, 'Page must be at least 1').default(1),
    limit: z.coerce.number().int().min(1).max(100, 'Limit cannot exceed 100').default(20),
    isRead: z
      .enum(['true', 'false'])
      .transform((val) => val === 'true')
      .optional(),
  }),
};

export const markReadSchema = {
  params: z.object({
    id: z.string().uuid('Invalid notification ID format. Must be a valid UUID.'),
  }),
};

export const testSendNotificationSchema = {
  body: z.object({
    title: z.string({ required_error: 'Title is required' }).trim().min(1, 'Title cannot be empty').max(200),
    body: z.string({ required_error: 'Body is required' }).trim().min(1, 'Body cannot be empty').max(1000),
    category: z.string().trim().max(50).optional().default('SYSTEM'),
    deepLinkUrl: z
      .string()
      .trim()
      .optional()
      .refine(
        (val) => {
          if (!val) return true;
          // Valid if relative URL starting with / or absolute http(s) URL
          if (val.startsWith('/')) return true;
          try {
            const parsed = new URL(val);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'Deep link URL must be a valid HTTP/HTTPS URL or absolute path (e.g. /jobs)' }
      ),
    metadata: z.record(z.any()).optional(),
  }),
};
