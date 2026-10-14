import { z } from 'zod';

export const loginSchema = {
  body: z.object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .email('Invalid email address')
      .toLowerCase(),
    password: z
      .string({ required_error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters long'),
  }),
};

export const forgotPasswordSchema = {
  body: z.object({
    email: z
      .string({ required_error: 'Email is required' })
      .trim()
      .email('Invalid email address')
      .toLowerCase(),
  }),
};

export const resetPasswordSchema = {
  body: z.object({
    token: z.string({ required_error: 'Reset token is required' }).min(16, 'Invalid reset token'),
    password: z
      .string({ required_error: 'New password is required' })
      .min(8, 'Password must be at least 8 characters long')
      .regex(/[0-9]/, 'Password must contain at least one number')
      .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character'),
  }),
};

export const verify2FALoginSchema = {
  body: z.object({
    adminId: z.string({ required_error: 'Admin ID is required' }),
    code: z
      .string({ required_error: 'Two-factor code is required' })
      .trim()
      .regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  }),
};

export const verifyBackupCodeLoginSchema = {
  body: z.object({
    adminId: z.string({ required_error: 'Admin ID is required' }),
    code: z
      .string({ required_error: 'Backup code is required' })
      .trim()
      .min(8, 'Backup code must be at least 8 characters'),
  }),
};

export const confirm2FASchema = {
  body: z.object({
    code: z
      .string({ required_error: 'Verification code is required' })
      .trim()
      .regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  }),
};

export const regenerateBackupCodesSchema = {
  body: z.object({
    password: z
      .string({ required_error: 'Password is required to confirm identity' })
      .min(1, 'Password is required'),
  }),
};
