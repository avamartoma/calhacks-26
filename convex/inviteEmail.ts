"use node";

// Emails someone when a project is shared with them. Sent from a team Gmail account with an app
// password (GMAIL_USER and GMAIL_APP_PASSWORD on the Convex deployment). Without those, invites
// still work and people see shared projects when they sign in; they just aren't told.

import nodemailer from "nodemailer";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { inviteMessage } from "./lib/inviteMessage";

declare const process: { env: Record<string, string | undefined> };

export const send = internalAction({
  args: { email: v.string(), inviter: v.string(), inviterEmail: v.optional(v.string()), project: v.string(), projectId: v.string(), role: v.union(v.literal("viewer"), v.literal("editor")) },
  handler: async (_ctx, args): Promise<{ sent: boolean }> => {
    const user = process.env.GMAIL_USER, pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
      console.log(`invite email to ${args.email} not sent: GMAIL_USER and GMAIL_APP_PASSWORD aren't set`);
      return { sent: false };
    }
    const message = inviteMessage(args);
    const transport = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
    try {
      await transport.sendMail({
        from: { name: "opencloud", address: user },
        to: args.email,
        ...(args.inviterEmail ? { replyTo: args.inviterEmail } : {}),
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
      return { sent: true };
    } catch (error) {
      // Never fail the invite over email; the person still sees the project when they sign in.
      console.error(`invite email to ${args.email} failed: ${error instanceof Error ? error.message : String(error)}`);
      return { sent: false };
    }
  },
});
