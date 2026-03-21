# Seeding vs. Context: the inbox bootstrapping problem

## How it works today

When a user runs `msgmon setup`, the final step "seeds" the workspace. Seeding
scans the user's Gmail and Slack accounts and records the IDs of existing
messages in a state file — but does not download any message content. The
inbox directory stays empty.

After seeding, future refreshes only download messages that arrived *after* the
seed point. This means the agent starts with a completely empty inbox and no
awareness of the user's communication history.

## Why seeding was built this way

The seed mechanism exists to solve a real problem: a user might have years of
email and thousands of Slack messages. Downloading all of that on first run
would be slow, expensive, and produce an overwhelming amount of content that
the agent can't meaningfully act on.

Seeding draws a line in the sand: "everything before this point already
happened, don't worry about it." This is the right behavior for deciding what
the agent should *act on* — it shouldn't try to reply to a thread from six
months ago.

## What the user actually needs

When a user sets up msgmon and starts the agent for the first time, they expect
the agent to have some understanding of their world. Who emails them. What
Slack channels are active and what's being discussed. What threads are open.
What tone and context surrounds recent conversations.

An agent that starts with an empty inbox has none of this. It can't make good
decisions about new messages because it has no frame of reference.

The user needs the agent to have recent history as context — not to act on it,
but to understand it. And they may want to control how far back that context
goes: maybe the last week, maybe the last month. They might also want to come
back later and pull in deeper history if the initial window wasn't enough.

## The tension

These are two different things:

- **Context**: recent messages the agent can see and learn from
- **Action boundary**: the point after which the agent should actively process
  and respond to new messages

Today, seeding conflates them. It sets the action boundary (correctly) but
provides zero context (incorrectly). The result is an agent that knows what's
new but doesn't understand anything about the world it's operating in.
