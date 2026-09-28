"""Chat models, chosen per role. Model IDs are pinned, never aliases, so behaviour only changes on purpose."""

from itertools import cycle

from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from gamenight_agents.settings import model_provider

HOST_MODEL = "claude-haiku-4-5-20251001"

FAKE_WELCOME = "Welcome to the room! Grab a seat, the games start soon."
FAKE_CHAT_REPLY = "I'm your AI host! With this many players, Undercover is a great first game."


class ScriptedChatModel(GenericFakeChatModel):
    """A free, deterministic stand-in for Claude in CI: same interface, including tool binding."""

    def bind_tools(self, tools, **kwargs):  # the scripted replies never call tools
        return self


def host_model() -> BaseChatModel:
    if model_provider() == "fake":
        return ScriptedChatModel(messages=cycle([AIMessage(FAKE_WELCOME)]))
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=HOST_MODEL, max_tokens=120, temperature=0.8, max_retries=2, timeout=20)


def chat_model() -> BaseChatModel:
    """The host agent's model for chat (tools bound by create_agent)."""
    if model_provider() == "fake":
        return ScriptedChatModel(messages=cycle([AIMessage(FAKE_CHAT_REPLY)]))
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=HOST_MODEL, max_tokens=400, temperature=0.5, max_retries=2, timeout=30)
