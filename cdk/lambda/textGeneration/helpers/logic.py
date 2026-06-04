import helpers.config as config


def get_current_prompt() -> str:
    """
    Assembles and returns the static system prompt from config components.
    XML tags are added here — the DB stores plain text for each component.
    """
    return f"""<role>
{config.ROLE}
</role>

<guardrails>
{config.GUARDRAILS}
</guardrails>

<instructions>
{config.INSTRUCTIONS}
</instructions>

<output_format>
{config.OUTPUT_FORMAT}
</output_format>""".strip()
