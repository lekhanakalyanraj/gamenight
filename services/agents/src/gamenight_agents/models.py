"""Chat models, chosen per role. Model IDs are pinned, never aliases, so behaviour only changes on purpose."""

import re
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult

from gamenight_agents.settings import model_provider

HOST_MODEL = "claude-haiku-4-5-20251001"
# The game master, content specialist and safety reviewer start on Haiku too; Sonnet 5 is the comparison
# in the full eval suite, and the model changes only if the numbers say so.
GAME_MASTER_MODEL = "claude-haiku-4-5-20251001"

FAKE_WELCOME = "Welcome to the room! Grab a seat, the games start soon."
FAKE_CHAT_REPLY = "I'm your AI host! With this many players, Undercover is a great first game."


class ScriptedChatModel(BaseChatModel):
    """A free, deterministic stand-in for Claude in CI: the same reply every time, streamed word by word.

    Only plain data, never an endless iterator (LangChain's GenericFakeChatModel takes one): the Agent Server
    dumps a run's model to JSON, and dumping `cycle([...])` never finished, so the server ran out of memory.
    """

    reply: str

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs: Any) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=AIMessage(self.reply))])

    def _stream(self, messages, stop=None, run_manager=None, **kwargs: Any):
        for token in re.findall(r"\S+\s*", self.reply):
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=token))
            if run_manager:
                run_manager.on_llm_new_token(token, chunk=chunk)
            yield chunk

    def bind_tools(self, tools, **kwargs):  # the scripted replies never call tools
        return self


def host_model() -> BaseChatModel:
    if model_provider() == "fake":
        return ScriptedChatModel(reply=FAKE_WELCOME)
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=HOST_MODEL, max_tokens=120, temperature=0.8, max_retries=2, timeout=20)


def chat_model() -> BaseChatModel:
    """The host agent's model for chat (tools bound by create_agent)."""
    if model_provider() == "fake":
        return ScriptedChatModel(reply=FAKE_CHAT_REPLY)
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=HOST_MODEL, max_tokens=400, temperature=0.5, max_retries=2, timeout=30)


def _anthropic(model: str, **kwargs) -> BaseChatModel:
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=model, max_retries=2, timeout=30, **kwargs)


def game_master_model() -> BaseChatModel:
    """Only for the real game master: with GAMENIGHT_MODEL=fake, scripted rules play instead (game_rules)."""
    return _anthropic(GAME_MASTER_MODEL, max_tokens=700, temperature=0.4)


def content_model(max_tokens: int = 600) -> BaseChatModel:
    """Word pairs need a few hundred tokens; a topic's quiz questions, each with its source sentence, need more."""
    return _anthropic(GAME_MASTER_MODEL, max_tokens=max_tokens, temperature=0.9)


def reviewer_model() -> BaseChatModel:
    return _anthropic(GAME_MASTER_MODEL, max_tokens=200, temperature=0)
