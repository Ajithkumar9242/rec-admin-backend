import { z } from 'zod';

export const updateProfileSchema = {
  body: z.object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters long').max(100).optional(),
    email: z.string().trim().email('Invalid email address').toLowerCase().optional(),
    currentPassword: z.string({ required_error: 'Current password is required to verify your identity' }).min(1),
  }).refine((data) => data.name !== undefined || data.email !== undefined, {
    message: 'Either name or email must be provided to update profile',
  }),
};

export const changePasswordSchema = {
  body: z.object({
    currentPassword: z.string({ required_error: 'Current password is required' }).min(1),
    newPassword: z
      .string({ required_error: 'New password is required' })
      .min(8, 'New password must be at least 8 characters long')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
  }),
};

export const dashboardQuerySchema = {
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    groupBy: z.enum(['day', 'month', 'year']).optional().default('day'),
  }).refine((data) => {
    if (data.from && data.to) {
      const fromDate = new Date(data.from);
      const toDate = new Date(data.to);
      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return false;
      }
      return fromDate <= toDate;
    }
    return true;
  }, {
    message: 'Start date cannot be after end date',
    path: ['from'],
  }),
};

export const exportQuerySchema = {
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    eventType: z.string().optional(),
    search: z.string().optional(),
  }).refine((data) => {
    if (data.from && data.to) {
      const fromDate = new Date(data.from);
      const toDate = new Date(data.to);
      if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
        return false;
      }
      return fromDate <= toDate;
    }
    return true;
  }, {
    message: 'Start date cannot be after end date',
    path: ['from'],
  }),
};
