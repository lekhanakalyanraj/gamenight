"""Chat models, chosen per role. Model IDs are pinned, never aliases, so behaviour only changes on purpose."""

from itertools import cycle

from langchain_core.language_models import BaseChatModel
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from gamenight_agents.settings import model_provider

HOST_MODEL = "claude-haiku-4-5-20251001"

FAKE_WELCOME = "Welcome to the room! Grab a seat, the games start soon."


def host_model() -> BaseChatModel:
    if model_provider() == "fake":
        return GenericFakeChatModel(messages=cycle([AIMessage(FAKE_WELCOME)]))
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=HOST_MODEL, max_tokens=120, temperature=0.8, max_retries=2, timeout=20)
