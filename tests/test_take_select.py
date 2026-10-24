"""§558 E2: lib/take_select.py picks one take per section by the select-takes skill's rules."""
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "lib"))

from lib.take_select import Unit, select  # noqa: E402
from steps.speech.rm_fillers import filler_matcher  # noqa: E402

_FILLER = filler_matcher("en")


def is_filler(tok):
    return bool(_FILLER.match(tok))


LINES = [
    "Start by picking the clip you want to edit.",
    "Then drag it onto the timeline below.",
    "Trim the start so it opens on the action.",
    "Finally export it at the size your phone wants.",
]


def filler_take(line):
    w = line.split()
    return " ".join([w[0], w[1] + ",", "um,", *w[2:]])


def restart_take(line):
    w = line.split()
    return " ".join([w[0], w[1] + "...", *w])


def units(*texts):
    return [Unit(t.split()) for t in texts]


def suggested(texts, sel):
    """(unit, the text the suggestion would leave, why) per suggestion."""
    us = units(*texts) if isinstance(texts[0], str) else texts
    out = []
    for i, drop, why in sel.suggest:
        gone = set(sel.drop.get(i, set())) | set(drop or ())
        out.append((i, " ".join(w for k, w in enumerate(us[i].words) if k not in gone) if drop else
                    " ".join(us[i].words), why))
    return out


def kept_text(texts, sel):
    us = units(*texts) if isinstance(texts[0], str) else texts
    out = []
    for i in sel.kept:
        drop = sel.drop.get(i, set())
        out.append(" ".join(w for k, w in enumerate(us[i].words) if k not in drop))
    return out


@pytest.mark.parametrize("split_restart", [False, True])
def test_three_takes_per_line_keeps_the_clean_last_take(split_restart):
    texts = []
    for line in LINES:
        texts.append(filler_take(line))
        if split_restart:   # the restart as its own line ("Start by..." then the full sentence)
            w = line.split()
            texts += [" ".join([w[0], w[1] + "..."]), line]
        else:
            texts.append(restart_take(line))
        texts.append(line)
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == LINES
    clean = [i for i, t in enumerate(texts) if t in LINES]
    clean_last = [max(i for i in clean if texts[i] == line) for line in LINES]
    assert sel.kept == clean_last
    assert len(sel.losers) == len(texts) - 4


def test_a_truncated_last_take_loses_to_an_earlier_complete_one():
    texts = [LINES[0], "Start by picking the clip", LINES[1]]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [0, 2]


def test_a_take_ending_in_an_ellipsis_is_truncated():
    texts = ["So this is the part where it breaks.", "So this is the part where it..."]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [0]


def test_last_attempt_wins_a_tie():
    """A B A across two clips: a retake of A in the second clip; the last attempt wins."""
    us = [Unit(LINES[0].split(), clip="A"), Unit(LINES[1].split(), clip="A"), Unit(LINES[0].split(), clip="B")]
    sel = select(us, is_filler)
    assert sel.kept == [2, 1]     # narrative order: the section of LINES[0] came first


def test_the_same_sentence_twice_in_one_clip_is_not_a_retake():
    texts = [LINES[0], LINES[1], LINES[0]]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts and sel.losers == []


def test_a_block_retake_keeps_only_the_second_block():
    texts = ["Start by picking the clip you want.", "Then drag it onto the timeline.",
             "Start by picking the clip you want.", "Then drag it onto the timeline below."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts[2:]


def test_fewer_flaws_beat_recency():
    us = [Unit(LINES[0].split()), Unit(LINES[0].split(), fillers=0, hesitations=2)]
    sel = select(us, is_filler)
    assert sel.kept == [0]


def test_within_take_repeat_keeps_the_final_occurrence():
    text = ("and always on mode, and always on mode called Kyros that basically lets "
            "and always on mode called Kyros")
    sel = select(units(text), is_filler)
    # the opening said again whole is cut; the partial repeat after it is only a suggestion
    assert kept_text([text], sel) == ["and always on mode called Kyros that basically lets and always on mode called Kyros"]
    assert suggested([text], sel) == [(0, "and always on mode called Kyros", "repeat?")]


def test_within_take_restart_from_the_opening_is_cut():
    text = "Start by, start by picking the clip you want to edit."
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["start by picking the clip you want to edit."]


def test_unrelated_lines_are_never_merged():
    texts = [
        "The first one is the simplest.",
        "The second one is the fastest.",
        "You want to edit the clip first.",
        "I think you should try it today.",
        "No answer.",
        "What's gone with that boy, I wonder?",
        "No answer.",
        *LINES,
    ]
    sel = select(units(*texts), is_filler)
    assert sel.kept == list(range(len(texts)))
    assert sel.losers == []


def test_short_lines_merge_only_when_adjacent():
    texts = ['"Tom!"', '"Tom!"', '"Tom!"', '"No answer."', LINES[0], '"No answer."']
    sel = select(units(*texts), is_filler)
    assert sel.kept == [2, 3, 4, 5]


def test_a_filler_only_unit_is_dropped():
    sel = select(units("Um.", LINES[0]), is_filler)
    assert sel.kept == [1] and sel.losers == [0]


def test_an_abandoned_opening_run_into_the_next_sentence_is_deleted():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    us = units(*texts)
    us[1].breaks = {4}                      # a pause before "Trim"
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts[:1] + ["Trim the start so it opens on the action."]
    assert sel.abandoned == [1]


def test_a_shared_opener_of_two_sentences_is_not_an_abandoned_take():
    texts = ["I want to show you the editor.", "I want to Talk about it later."]
    sel = select(units(*texts), is_filler)
    assert sel.abandoned == [] and sel.drop == {}


# ── never cut: sentences that repeat words but are not retakes (review 2) ───
# Each case is a run of sentences one speaker said in one clip; every word must survive.
FILLERS = ["This part is filler one.", "Here is another thought.", "Something else entirely.",
           "Moving on to the next step.", "One more aside here."]
NEVER_CUT = {
    "and-then list": ["You open the app and then you pick a clip and then you trim it and then you export."],
    "you want twice": ["You want to pick the clip you want to edit first."],
    "a lot of": ["A lot of people use it and a lot of them love it."],
    "anaphora": ["We shall fight on the beaches, we shall fight on the landing grounds, we shall fight in the fields."],
    "lo que (es)": ["Lo que más me gusta es lo que hace con el audio."],
    "the more": ["The more you edit, the more you learn."],
    "if you": ["If you want it, if you need it, just buy it."],
    "this is": ["This is it, this is the one I wanted."],
    "never never": ["Never, never, never give up."],
    "best part": ["The best part is the price.", "The best part is the speed."],
    "cut your": ["You can cut your clips in one click.", "You can cut your audio in one click.",
                 "You can cut your captions in one click."],
    "reason": ["The reason I love it is that it is fast.", "The reason I love it is that it is cheap."],
    "puedes (es)": ["Puedes cortar tus clips en un clic.", "Puedes cortar tu audio en un clic."],
    "proper noun": ["We launched it on Monday at noon.", "We launched it on Product Hunt the next week."],
    "product name": ["Then I opened the app.", "Then I opened the Montaj editor and trimmed it."],
    "refrain": ["This is the way we do it.", *FILLERS, "This is the way we do it."],
    "callback": ["Here's the thing.", *FILLERS, "Here's the thing about pricing."],
    "short then longer": ["I built an app.", "It took a year.", "I built an app that edits videos for you."],
    "question grows": ["What if you could edit faster?", "What if you could edit faster and cheaper?"],
    "first and best": ["The first one is the simplest.", "The first one is the easiest."],
    # re-review: parallel clauses (rule B), questions and echoes, the same sentence in two places
    "parallel easy/fast": ["We want to make it easy, and we want to make it fast."],
    "parallel edit fast/well": ["You need to be able to edit fast and you need to be able to edit well."],
    "list first/second": ["I'm going to show you the first one then I'm going to show you the second one."],
    "store today/tomorrow": ["Let's go to the store and then let's go to the store again tomorrow."],
    "es vamos a ver": ["Vamos a ver cómo se hace y vamos a ver cómo se usa."],
    "es quiero que": ["Quiero que sea fácil de usar y quiero que sea fácil de vender."],
    "fr on va voir": ["On va voir comment ça marche et on va voir comment ça se vend."],
    "de wir wollen": ["Wir wollen es einfach machen und wir wollen es schnell machen."],
    "pt e": ["Eu quero que seja fácil de usar e eu quero que seja fácil de vender."],
    "it e": ["Voglio che sia facile da usare e voglio che sia facile da vendere."],
    "long anaphora no commas": ["I want you to try it today and I want you to try it tomorrow and I want you to tell a friend."],
    "q then echo": ["Can you do it on your phone?", "You can do it on your phone."],
    "q echo 2": ["Is it really that easy?", "It really is that easy."],
    "de frage": ["Ist es schwer zu lernen?", "Es ist schwer zu lernen."],
    "es same q": ["¿Lo puedes hacer en el móvil?", "Lo puedes hacer en el móvil."],
    "yes no": ["Should you buy it?", "Yes, you should buy it."],
    "some say / not": ["Some say you should post every day.", "You should not post every day."],
    "people ask": ["People ask if it works on Windows.", "It works on Windows."],
    "think/dont": ["You think you need a studio.", "You don't need a studio."],
    "used to": ["I used to spend hours on every video.", "Now I spend minutes on every video."],
    "before after": ["Before, it took me an hour to cut a video.", "Now it takes me a minute to cut a video."],
    "quote then answer": ["My friend said this will never work.", "This will work."],
    "not only": ["It is not only fast.", "It is fast and cheap."],
    "es contraste": ["Dicen que es difícil de usar.", "No es difícil de usar."],
    "instruction twice": ["Pick your clip.", "Then click export.", "Choose the format.", "Then click export."],
    "instruction twice 2": ["Open the settings menu.", "Turn on captions.", "Go back.", "Open the settings menu.",
                            "Turn on music."],
    "refrain 3 apart": ["Make it short.", "That's the whole point.", "Nobody watches long videos.", "Keep it tight.",
                        "That's the whole point."],
    "tutorial repeat click": ["Click the plus button.", "Pick a song.", "Click the plus button again.", "Pick a font."],
    "dup short far": ["Let's go.", "First open the app.", "Let's go."],
    "emphasis really": ["It's really, really good."],
    "emphasis very": ["It is very, very, very fast."],
    "it works x2": ["It works.", "It works!"],
    "negation drop": ["This is not a toy.", "This is a toy for adults."],
    "not hard": ["Editing is not hard.", "Editing is hard if you do it the old way."],
    "correction drop": ["You can export to TikTok and YouTube today.", "You can export to YouTube today."],
    "counting": ["One, two, three, four, five, six, seven, eight, nine, ten."],
    "date": ["On the first of May and the first of June we ship."],
    "abc": ["A B C D E A B C D F."],
    "same sentence diff context": ["My first video got ten views.", "I kept posting.",
                                   "My first video got ten views, and now I get millions."],
    "steps same template": ["Step one, open the app.", "Step two, open the editor.", "Step three, open the export menu."],
    "build up": ["This changes everything.", "This changes everything about how we edit."],
    "dialogue": ["He said, I'm leaving.", "She said, I'm leaving too."],
    "contrast pair": ["Some people edit for hours.", "Some people edit for minutes."],
    "repeat with insert": ["I love this app.", "I really love this app."],
    "names list": ["Thanks to John and Mary and John's mom and Mary's mom."],
    "es lists": ["Primero abres la app y luego abres el editor y luego abres la exportación."],
    "es correction": ["Cuesta diez dólares.", "Perdón, cuesta veinte dólares."],
    "if then": ["If it works for me it works for you."],
    "rule of three": ["Faster to cut faster to caption faster to post."],
    "two numbers": ["We grew to ten thousand users in May.", "We grew to twenty thousand users in June."],
}


@pytest.mark.parametrize("name", sorted(NEVER_CUT))
def test_never_cut(name):
    texts = NEVER_CUT[name]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts, name
    assert sel.losers == [] and sel.abandoned == []


def test_a_stutter_of_a_whole_clause_is_cut_by_design():
    """The accepted residual: a clause said whole twice in a row reads as a stutter and keeps the last."""
    text = "never give up, never give up, never give up on your dream"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["never give up on your dream"]


def test_a_cut_off_word_retake_is_cut():
    text = "and always on mo- and always on mode called Kyros"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["and always on mode called Kyros"]


def test_an_abandoned_opening_needs_a_break_before_the_new_sentence():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    no_break = select(units(*texts), is_filler)
    assert kept_text(texts, no_break) == texts
    us = units(*texts)
    us[1].breaks = {4}
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts[:1] + ["Trim the start so it opens on the action."]


def test_a_retake_far_away_in_another_clip_still_joins():
    us = [Unit(LINES[0].split(), clip="A"), *[Unit(t.split(), clip="A") for t in FILLERS], Unit(LINES[0].split(), clip="B")]
    sel = select(us, is_filler)
    assert len(sel.kept) == 1 + len(FILLERS) and sel.kept[0] == len(us) - 1


def test_a_later_longer_take_wins_over_fewer_flaws():
    """Takes that differ in words: the last complete one wins (a spoken correction), whatever the flaws."""
    us = [Unit("It costs twenty dollars.".split()),
          Unit("It costs twenty dollars a month.".split(), fillers=1, hesitations=1)]
    sel = select(us, is_filler)
    assert sel.kept == [0, 1] and sel.losers == []
    assert [(i, why) for i, _, why in sel.suggest] == [(0, "false-start?")]


def test_an_immediate_longer_retake_of_a_period_sentence_is_only_suggested():
    texts = ["I built an app.", "I built an app that edits videos for you."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts
    assert suggested(texts, sel) == [(0, "I built an app.", "false-start?")]


def test_a_reworded_retake_is_only_suggested():
    texts = ["I love this app.", "I really love this app."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts and sel.losers == []
    assert suggested(texts, sel) == [(0, "I love this app.", "retake?")]


# Doubles said word for word: a stutter, cut, and listed as removed (the caller shows sel.why).
STUTTER_CUT = {
    "come on": ("Come on, come on, let's go.", "come on, let's go."),
    "i love it": ("I love it, I love it so much.", "I love it so much."),
    "the thing is": ("The thing is the thing is hard to explain.", "the thing is hard to explain."),
}


@pytest.mark.parametrize("name", sorted(STUTTER_CUT))
def test_a_word_for_word_double_is_cut_and_listed(name):
    text, kept = STUTTER_CUT[name]
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == [kept] and sel.why[0] == "restart"
