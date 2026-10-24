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
    """Units from sentences. "##" starts the next clip; "|" inside a sentence is a timing break before the next
    word."""
    us, clip = [], "A"
    for t in texts:
        if t == "##":
            clip = chr(ord(clip) + 1)
            continue
        words, breaks = [], set()
        for tok in t.split():
            if tok == "|":
                breaks.add(len(words))
            else:
                words.append(tok)
        us.append(Unit(words, clip=clip, breaks=breaks))
    return us


def plain(texts):
    """The sentences as said: no clip or break marks."""
    return [" ".join(w for w in t.split() if w != "|") for t in texts if t != "##"]


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
    """A A said again at once: the last attempt wins."""
    texts = [LINES[0], LINES[0], LINES[1]]
    sel = select(units(*texts), is_filler)
    assert sel.kept == [1, 2]


def test_a_b_a_across_two_clips_is_only_suggested():
    us = [Unit(LINES[0].split(), clip="A"), Unit(LINES[1].split(), clip="A"), Unit(LINES[0].split(), clip="B")]
    sel = select(us, is_filler)
    assert sel.kept == [0, 1, 2] and sel.losers == []
    assert [(i, w) for i, _, w in sel.suggest] == [(0, "retake?")]


def test_the_same_sentence_twice_in_one_clip_is_not_a_retake():
    texts = [LINES[0], LINES[1], LINES[0]]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts and sel.losers == []


def test_a_block_retake_with_a_change_is_only_suggested():
    texts = ["Start by picking the clip you want.", "Then drag it onto the timeline.",
             "Start by picking the clip you want.", "Then drag it onto the timeline below."]
    sel = select(units(*texts), is_filler)
    assert kept_text(texts, sel) == texts and sel.losers == []
    assert [(i, w) for i, _, w in sel.suggest] == [(0, "retake?"), (1, "retake?")]


def test_an_identical_block_retake_keeps_only_the_second_block():
    texts = ["Start by picking the clip you want.", "Then drag it onto the timeline.",
             "Start by picking the clip you want.", "Then drag it onto the timeline."]
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
    # no break signal between the two sayings: kept, only suggested
    assert kept_text([text], sel) == [text] and sel.drop == {}
    assert ("and always on mode called Kyros that basically lets and always on mode called Kyros", "repeat?") in \
        [(t, w) for _, t, w in suggested([text], sel)]
    # a pause before the second saying: the opening said again is cut; the partial repeat stays a suggestion
    paused = ("and always on mode, | and always on mode called Kyros that basically lets "
              "and always on mode called Kyros")
    us = units(paused)
    sel = select(us, is_filler)
    assert kept_text(us, sel) == ["and always on mode called Kyros that basically lets and always on mode called Kyros"]
    assert suggested(us, sel) == [(0, "and always on mode called Kyros", "repeat?")]


def test_a_short_restart_is_only_suggested():
    text = "Start by, start by picking the clip you want to edit."
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == [text]
    assert suggested([text], sel) == [(0, "start by picking the clip you want to edit.", "restart?")]


def test_a_restart_after_a_cut_off_word_is_cut():
    text = "Start by... start by picking the clip you want to edit."
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


def test_short_lines_said_again_are_only_suggested():
    texts = ['"Tom!"', '"Tom!"', '"Tom!"', '"No answer."', LINES[0], '"No answer."']
    sel = select(units(*texts), is_filler)
    assert sel.kept == list(range(6)) and sel.losers == []
    assert [(i, w) for i, _, w in sel.suggest] == [(0, "retake?"), (1, "retake?")]


def test_a_filler_only_unit_is_dropped():
    sel = select(units("Um.", LINES[0]), is_filler)
    assert sel.kept == [1] and sel.losers == [0]


def test_an_abandoned_opening_run_into_the_next_sentence_is_deleted():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    us = units(*texts)
    us[1].breaks = {4}                      # a pause before "Trim"
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts and sel.losers == []    # only offered: "Trim" might be a name
    assert suggested(texts, sel) == [(1, "Trim the start so it opens on the action.", "abandoned?")]


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
    # pass 3 (5 languages): everything below is kept; the real retakes among them are only suggested (SUGGESTED)
    "tut ordinal list": ["First, open the Settings tab.", "Second, open the Privacy tab.", "Third, open the Advanced tab."],
    "tut click save again": ["Click save.", "Wait for it to load.", "Click save again."],
    "tut before/after": ["Make sure you hit save before you close the app.", "Make sure you hit save after every change too."],
    "tut gonna retake": ["So the first thing you gonna do is open the project.",
                         "So the first thing you want to do is open your project."],
    "tut false start period": ["Now go to the.", "Now go to the export menu and pick MP4."],
    "tut block retake": ["Open the app.", "Tap the plus.", "Open the app.", "Tap the plus button at the bottom."],
    "tut block across clips": ["Hey guys, welcome back to the channel.", "Today we're making pasta.", "##",
                               "Hey guys, welcome back to the channel.", "Today we're making fresh pasta from scratch."],
    "tut 4K comma": ["You can export it in 4K, you can export it in 1080p."],
    "tut 4K nocomma": ["You can export it in 4K you can export it in 1080p."],
    "tut unpunct": ["so the first thing you do is open the app and the first thing you do after that is pick a clip"],
    "vlog lake": ["We woke up at six.", "We drove to the lake.", "We swam in the lake.", "We drove home."],
    "vlog callback": ["Remember the lake?", "We got lost twice.", "We ate tacos.", "Remember the lake from this morning?"],
    "vlog worth it": ["Was it worth it?", "Absolutely, it was worth it."],
    "vlog so cold": ["It was cold, so cold, so so cold."],
    "vlog correction money": ["We spent three hundred dollars.", "No wait, we spent four hundred dollars."],
    "vlog days": ["Day one.", "Day two.", "Day three."],
    "pitch anaphora": ["Montaj cuts your video.", "Montaj captions your video.", "Montaj posts your video."],
    "pitch not toy": ["It's not a toy, it's a tool."],
    "pitch not just": ["It's not just faster, it's better."],
    "pitch hours minutes": ["Other apps take hours.", "Montaj takes minutes."],
    "pitch nine not ninety": ["Our price is nine dollars a month.", "That's nine dollars, not ninety."],
    "pitch insert retake": ["Montaj is the fastest way to edit video.", "Montaj is honestly the fastest way to edit video."],
    "pitch three plans": ["We have three plans.", "We have three plans and a free trial."],
    "pitch free free!": ["It's free.", "It's free!"],
    "pitch was wrong": ["I was wrong.", "I was so wrong."],
    "int echo replace": ["What made you start?", "What made me start was boredom."],
    "int think so": ["I think so.", "I think so, yes."],
    "int quit": ["Did you ever want to quit?", "Every single day I wanted to quit."],
    "int no no no": ["No, no, no, that's not what I meant."],
    "int yes yes": ["Yes.", "Yes."],
    "int two cams": ["You need two cameras.", "Actually, you only need one camera."],
    "story knocked": ["He knocked once.", "He knocked twice.", "He knocked a third time."],
    "story door": ["And then the door opened.", "A man walked in.", "And then the door closed."],
    "story quote": ["She looked at me and said, 'You'll never make it.'", "And I said, 'Watch me.'",
                    "'You'll never make it,' she said again."],
    "story said": ["I said no.", "She said yes.", "We both said maybe."],
    "story refrain 2 apart": ["And that's when it hit me.", "I was broke.", "And that's when it hit me."],
    "story failed": ["The first time I failed.", "The second time I failed.", "The third time I won."],
    "story this one": ["Not this one.", "This one."],
    "story reworded super/really": ["The app is super easy to use.", "The app is really easy to use."],
    "es magia": ["No es magia, es práctica."],
    "es primero despues": ["Primero grabas el video.", "Después grabas el audio."],
    "es retake period": ["Hoy les voy a enseñar a editar.", "Hoy les voy a enseñar a editar un video en un minuto."],
    "es correction pasos": ["Son cinco pasos.", "Perdón, son seis pasos."],
    "es q answer": ["¿Es difícil?", "No, no es difícil."],
    "es movil y movil": ["Lo grabas en el móvil y lo editas en el móvil."],
    "es retake reword": ["Hoy vamos a hacer una receta muy fácil.", "Hoy vamos a hacer una receta súper fácil."],
    "fr pas difficile": ["Ce n'est pas difficile, c'est juste nouveau."],
    "fr on ouvre": ["On ouvre l'application.", "On choisit la vidéo.", "On ouvre l'éditeur."],
    "fr retake period": ["Alors aujourd'hui on va voir comment monter une vidéo.",
                         "Alors aujourd'hui on va voir comment monter une vidéo en deux minutes."],
    "fr vite loin": ["Tu veux aller vite ?", "Tu veux aller loin ?"],
    "fr quote": ["Il a dit : « Je reviens. »", "Et il n'est jamais revenu."],
    "de erst dann": ["Erst schneidest du das Video, dann schneidest du den Ton."],
    "de nicht schwer": ["Das ist nicht schwer.", "Das ist nur neu."],
    "de false start period": ["Heute zeige ich euch, wie man.", "Heute zeige ich euch, wie man ein Video schneidet."],
    "de speichern": ["Drück auf Speichern.", "Warte kurz.", "Drück nochmal auf Speichern."],
    "de views": ["Willst du mehr Views?", "Dann poste jeden Tag."],
    "de nocomma parallel": ["Ich schneide das Video und ich schneide den Ton und ich lade alles hoch."],
    "pt magica": ["Não é mágica, é prática."],
    "pt primeiro depois": ["Primeiro você grava, depois você edita, depois você posta."],
    "pt retake period": ["Hoje eu vou mostrar como editar.", "Hoje eu vou mostrar como editar um vídeo no celular."],
    "pt crescer vender": ["Você quer crescer?", "Você quer vender?"],
    "pt falei": ["Eu falei que não.", "Ela falou que sim."],
    "pt nocomma": ["Você grava o vídeo você grava o áudio e pronto."],
    "abandon rome paris": ["We flew to Rome on Monday.", "We flew to | Paris on Friday."],
    "abandon talked john mary": ["I talked to John about it.", "I talked to | Mary about it later."],
    "abandon de noun": ["Wir haben das Video geschnitten.", "Wir haben das | Audio auch geschnitten."],
    "abandon de noun 2": ["Dann öffnest du die App.", "Dann öffnest du | Einstellungen und tippst auf Export."],
    "abandon es city": ["Después fuimos a Roma.", "Después fuimos a | París."],
    "abandon pt": ["Depois eu abri o Instagram.", "Depois eu abri | TikTok e postei."],
    "abandon fr": ["Ensuite on est allés à Lyon.", "Ensuite on est allés | Marseille aussi."],
    "hold on": ["Hold on.", "Hold on to your seat."],
    "look out": ["Look out.", "Look out the window."],
    "try it": ["Try it.", "Try it for free today."],
    "es espera": ["Mira esto.", "Mira esto con calma."],
    "aside sorry": ["Today I'm going to show you my morning routine.", "Sorry, let me do that again.",
                    "Today I'm going to show you my morning routine."],
    "aside wait": ["This lens costs two thousand dollars.", "Wait.", "This lens costs twelve hundred dollars."],
    "aside okay again": ["So this is my whole setup for streaming.", "Okay, one more time.",
                         "So this is my whole setup for streaming at home."],
    "aside es": ["Hoy les traigo mi rutina de mañana.", "Perdón, otra vez.", "Hoy les traigo mi rutina de mañana."],
    "block B' low ratio same clip": ["Welcome back to the channel.", "Today we're making pasta.",
                                     "Welcome back to the channel.", "Today we're making fresh pasta from scratch."],
    "cross clip refrain": ["Step one is to open the app.", "Now let's move on to the next step.", "##",
                           "Step two is to pick a clip.", "Now let's move on to the next step.", "##",
                           "Step three is to export it.", "Now let's move on to the next step."],
    "cross clip tagline": ["My first tip is to post daily.", "Follow me for more tips like this.", "##",
                           "My second tip is to use hooks.", "Follow me for more tips like this."],
    "new york": ["New York, New York is my favorite song."],
    "bora bora": ["We went to Bora Bora, Bora Bora is amazing."],
    "tick tock": ["Tick tock, tick tock, the clock is ticking."],
    "again and again": ["You fail again and again and again until you win."],
    "numbers repeat": ["It costs ten dollars, ten dollars a month, that's it."],
    "phone digits": ["Call five five five, five five five, one two three four."],
    "years": ["In twenty twenty, twenty twenty one and twenty twenty two we grew."],
    "rhet": ["Why does this matter?", "Why does this matter to you?"],
    "rhet answer": ["What's the secret?", "The secret is consistency."],
    "rhet same q twice": ["Is it worth it?", "Let me show you.", "Is it worth it?", "Yes."],
    "not but": ["It's not about the camera, it's about the story."],
    "not X but Y es": ["No se trata de la cámara, se trata de la historia."],
    "not X but Y de": ["Es geht nicht um die Kamera, es geht um die Geschichte."],
    "not X but Y fr": ["Il ne s'agit pas de la caméra, il s'agit de l'histoire."],
    "not X but Y pt": ["Não se trata da câmera, se trata da história."],
    "contrast sentences": ["Some creators post once a week.", "Some creators post three times a day."],
    "list nocomma": ["You need a camera a microphone a light and a tripod."],
    "list repeated verb nocomma": ["You open the app you pick a clip you trim it you export it."],
    "list repeated long nocomma": ["We want people to feel safe we want people to feel seen and we want people to come back."],
    "quote callback": ["My dad always said work hard.", "So I worked hard.", "And like my dad always said work hard."],
    "quoted retake-like": ["He said I'm done.", "He said I'm done with this job."],
    "correction insert": ["The app is available on iPhone.", "The app is available on iPhone and Android."],
    "correction not": ["This works on Windows.", "This only works on Mac."],
    "correction es insert": ["Funciona en iPhone.", "Funciona en iPhone y en Android."],
    "correction de": ["Es kostet zehn Euro.", "Es kostet zehn Euro im Monat."],
    "block story called": ["I called her again.", "She didn't answer.", "I called her again.",
                           "She didn't answer that time either."],
    "block story tried": ["We tried it once more.", "It failed.", "We tried it once more.", "It failed even worse this time."],
    "block tutorial two songs": ["Tap the plus button.", "Pick a song.", "Tap the plus button.", "Pick a song for the outro."],
    "block es llamé": ["La llamé por teléfono.", "No contestó.", "La llamé por teléfono.", "No contestó tampoco esa vez."],
    "block de": ["Ich habe sie angerufen.", "Sie ging nicht ran.", "Ich habe sie angerufen.", "Sie ging wieder nicht ran."],
    "block fr": ["Je l'ai appelée encore.", "Elle n'a pas répondu.", "Je l'ai appelée encore.",
                 "Elle n'a pas répondu non plus."],
    "block pt": ["Eu liguei pra ela.", "Ela não atendeu.", "Eu liguei pra ela.", "Ela não atendeu de novo."],
    "block reworded B' (insert)": ["So let me show you the editor.", "It looks like this.", "So let me show you the editor.",
                                   "It looks pretty much like this."],
    "chorus": ["We will rise again.", "When the night is long.", "We will rise again.", "When the night is over."],
    "he said no no": ["He said no, no, no, I won't do it."],
    "run run run": ["I run, run, run every morning."],
    "dash aside": ["This is the -", "Actually, let me show you the settings first."],
    "dash list": ["You get speed —", "you get quality —", "and you get it all for free."],
    "come on": ["Come on, come on, let's go."],
    # word for word with no break signal: a chant, an emphasis, a restart said straight through
    "quoted chant": ["The crowd kept chanting one more song, one more song, one more song."],
    "i love it": ["I love it, I love it so much."],
    "the thing is": ["The thing is the thing is hard to explain."],
    "fr restart": ["Donc on va, donc on va ouvrir le projet."],
    # pass 4 (5 languages): every case below keeps all its words; the real retakes are offered (SUGGESTED)
    "p4 tut shortcut keys": ["Press command C, then command V."],
    "p4 tut layer names": ["Select layer one, layer two and layer three."],
    "p4 tut repeat step": ["Drag the handle to the left.", "Now drag the handle to the right."],
    "p4 tut prefix word art/artist": ["Look at the art, look at the artist."],
    "p4 tut prefix key/keyboard": ["Grab the key, grab the keyboard too."],
    "p4 tut paused prefix plural": ["Pick the clip, | pick the clips you want."],
    "p4 tut retake reword gonna": ["Now we're going to add the music.", "Now we're gonna add the music."],
    "p4 tut retake numbers": ["Set the speed to two x.", "Set the speed to one point five x."],
    "p4 tut same instruction refrain": ["Hit save.", "Hit save.", "And hit save again."],
    "p4 vlog place names": ["We went from Paris to Lyon, then Lyon to Nice."],
    "p4 vlog walla walla": ["We stopped in Walla Walla, | Walla Walla has great onions."],
    "p4 vlog so good": ["This coffee is so good.", "Like, so good."],
    "p4 vlog day counts": ["Day five, day six, day seven, we're still here."],
    "p4 vlog retake intro": ["Good morning guys, welcome to my vlog.", "Good morning guys, and welcome back to my vlog."],
    "p4 vlog he said she said": ["He said we were late.", "She said we were early."],
    "p4 vlog tired": ["I'm tired.", "I'm so tired.", "But it was worth it."],
    "p4 vlog ellipsis suspense same": ["And then...", "and then...", "it rained."],
    "p4 pitch numbers growth": ["Ten users became a hundred, a hundred became a thousand."],
    "p4 pitch percentages": ["We cut costs by twenty percent, twenty percent in one quarter."],
    "p4 pitch three reasons": ["There are three reasons.", "Reason one, speed.", "Reason two, price.", "Reason three, support."],
    "p4 pitch retake company name": ["We are Acme Labs.", "We are Acme Labs and we build robots."],
    "p4 pitch correction price": ["It costs ninety nine dollars.", "Sorry, it costs forty nine dollars."],
    "p4 pitch emphasis": ["This is huge.", "This is really huge."],
    "p4 pitch tagline twice far": ["Edit less, post more.", "That's our promise.", "We mean it.", "Our users love it.", "Edit less, post more."],
    "p4 int echo question": ["How did you start?", "How did I start?", "Well, I was broke."],
    "p4 int answer yes yes": ["Yes, yes, absolutely."],
    "p4 int interviewer then guest same": ["So you quit your job.", "So I quit my job, yeah."],
    "p4 int retake pause": ["The hardest part was hiring.", "The hardest part was | hiring the first engineer."],
    "p4 int quote of quote": ["She told me, you know what, you know what you should do?"],
    "p4 int you know you know": ["You know, you know what I mean?"],
    "p4 story knock knock": ["Knock knock.", "Who's there?"],
    "p4 story waited and waited": ["We waited and waited and waited."],
    "p4 story callback line": ["Dad said, never trust a quiet dog.", "Years passed.", "I got a dog.", "It was quiet.", "Dad said, never trust a quiet dog."],
    "p4 story list names": ["There was Anna, Ben, Anna's sister, and Ben's dog."],
    "p4 story repeat with pause emphasis": ["It was dark. | It was cold.", "And I was alone."],
    "p4 story door knocked block identical": ["He knocked on the door.", "Nobody came.", "He knocked on the door.", "Nobody came."],
    "p4 pod no way": ["No way.", "No way!", "Are you serious?"],
    "p4 pod right right": ["Right, right, right, exactly."],
    "p4 pod overlap": ["I think the thing is", "the thing is nobody knows."],
    "p4 pod laugh": ["That's so funny.", "That's so funny, man."],
    "p4 pod correction name": ["I talked to Mike.", "Not Mike, Mark."],
    "p4 pod yeah yeah": ["Yeah, yeah, yeah, totally."],
    "p4 es numbers": ["Son las dos, las dos y media ya."],
    "p4 es diminutive": ["Es una casa, es una casita."],
    "p4 es retake": ["Hoy les voy a mostrar mi cocina.", "Hoy les quiero mostrar mi cocina."],
    "p4 es lista": ["Necesitas harina, huevos, harina de maíz y sal."],
    "p4 es contraste": ["No es caro, es barato."],
    "p4 fr nombres": ["Il est huit heures, huit heures et demie."],
    "p4 fr retake": ["Aujourd'hui je vais vous montrer ma routine.", "Aujourd'hui je vais vous présenter ma routine."],
    "p4 fr anaphore": ["Je veux, je peux, je dois."],
    "p4 fr ne pas": ["C'est pas cher.", "C'est cher."],
    "p4 fr villes": ["On est allés à Paris, puis Paris encore."],
    "p4 de Komposita prefix": ["Wir brauchen Licht, wir brauchen Lichtschalter."],
    "p4 de Haus Haustier": ["Ich habe ein Haus, ich habe ein Haustier."],
    "p4 de retake": ["Heute zeige ich euch meine Küche.", "Heute zeige ich euch meine neue Küche."],
    "p4 de nicht": ["Das ist gut.", "Das ist nicht gut."],
    "p4 de Zahlen": ["Es kostet zwanzig Euro, zwanzig Euro im Monat."],
    "p4 pt diminutivo": ["É um cachorro, é um cachorrinho."],
    "p4 pt retake": ["Hoje eu vou mostrar minha rotina.", "Hoje eu vou mostrar a minha rotina."],
    "p4 pt numeros": ["Custa dez reais, dez reais por mês."],
    "p4 pt contraste": ["Não é difícil, é fácil."],
    "p4 block short 2nd line, story": ["He knocked on the door.", "Nobody came.", "He knocked on the door.", "Nobody came."],
    "p4 block short 2nd line, story changed": ["He knocked on the door.", "Silence.", "He knocked on the door.", "Nothing."],
    "p4 block short first line": ["Okay.", "Let's open the project now.", "Okay.", "Let's open the project now."],
    "p4 story anaphora pause": ["I was scared. | I was alone. | I was nine."],
    "p4 hyphen compound": ["It's a well-known, well-known fact."],
    "p4 dash cut-off name": ["We hired Jen —", "We hired Jennifer last week."],
    "p4 abandoned tail differs": ["The reason we started this company was to help—", "The reason we started this company was to make money."],
    "p4 quote said twice": ["He kept saying, I'm fine, I'm fine, I'm fine."],
    "p4 es repeat pause names": ["Fuimos a Bora Bora, | Bora Bora es increíble."],
    "p4 de prefix Spiel/Spielplatz": ["Wir gehen zum Spiel, | wir gehen zum Spielplatz."],
    "p4 en prefix car/cart pause": ["Put it in the car, | put it in the cart."],
    "p4 en prefix plural nocomma": ["I love the dog I love the dogs here."],
    "p4 en three sayings pause": ["Go, | go, | go!"],
    "p4 en number+word chant": ["Five, six, seven, eight, five, six, seven, eight."],
    "p4 en spelled name": ["It's spelled S A M, S A M."],
    "p4 en address": ["Number ten, ten Downing Street."],
    "p4 name start pause": ["New York, | New York is my favorite song."],
    "p4 name start pause 2": ["Bora Bora, | Bora Bora is amazing."],
    "p4 sing sing": ["Sing Sing, | Sing Sing is a prison."],
    "p4 es mismo nombre": ["Bogotá, | Bogotá es mi ciudad."],
    "p4 block where 2nd line longer by 1 short": ["Open the app.", "Tap edit.", "Open the app.", "Tap edit now."],
    "p4 block A then remark": ["He knocked on the door.", "Nobody came.", "He knocked on the door.", "Nobody came at all."],
    "p4 pod retake whole answer w/ pause": ["I think the market is ready.", "Sorry.", "I think the market is ready."],
    "p4 pod real retake 2 apart": ["The biggest mistake was pricing.", "Hold on.", "Let me restart.", "The biggest mistake was pricing."],
    "p4 story ellipsis abandoned diff": ["Since Montage was...", "Feedback is welcome."],
    "p4 story fist": ["It turns those... A fist, a fist, a point."],
    "p4 open tail differs across clips": ["So the best part of this app is the price", "##", "So the best part of this app is the speed."],
    "p4 comma tail differs across clips": ["We shipped it to Canada, Mexico and Brazil,", "##", "We shipped it to Canada, Mexico and Chile."],
    "p4 ellipsis tail differs": ["My favourite city is Tokyo...", "My favourite city is Kyoto, actually."],
    "p4 es open tail": ["Lo mejor de esta app es el precio y la", "##", "Lo mejor de esta app es el precio y el soporte."],
    "p4 longer ellipsis take then shorter": ["We tested it in Berlin and in Paris...", "We tested it in Berlin."],
    "p4 longer dash take then shorter": ["The app is fast and cheap and really fun to —", "The app is fast and cheap."],
    "p4 es longer ellipsis": ["Fuimos a Madrid y luego a Sevilla...", "Fuimos a Madrid y a Sevilla."],
    "p4 open longer then shorter across clips": ["We sold ten thousand copies in the first week and", "##", "We sold ten thousand copies in the first week."],
}

# Real retakes among NEVER_CUT: kept, and offered as (unit, why).
SUGGESTED = {
    "repeat with insert": [(0, "retake?")],
    "build up": [(0, "false-start?")],
    "correction drop": [(0, "retake?")],
    "tut gonna retake": [(0, "retake?")],
    "tut false start period": [(0, "false-start?")],
    "tut block retake": [(0, "retake?"), (1, "retake?")],
    "tut block across clips": [(0, "retake?"), (1, "retake?")],
    "pitch insert retake": [(0, "retake?")],
    "pitch three plans": [(0, "false-start?")],
    "pitch was wrong": [(0, "retake?")],
    "int think so": [(0, "false-start?")],
    "int yes yes": [(0, "retake?")],
    "story reworded super/really": [(0, "retake?")],
    "es retake period": [(0, "false-start?")],
    "es retake reword": [(0, "retake?")],
    "fr retake period": [(0, "false-start?")],
    "de false start period": [(0, "false-start?")],
    "pt retake period": [(0, "false-start?")],
    "abandon rome paris": [(1, "abandoned?")],
    "abandon talked john mary": [(1, "abandoned?")],
    "abandon de noun": [(1, "abandoned?")],
    "abandon de noun 2": [(1, "abandoned?")],
    "abandon es city": [(1, "abandoned?")],
    "abandon pt": [(1, "abandoned?")],
    "abandon fr": [(1, "abandoned?")],
    "hold on": [(0, "false-start?")],
    "look out": [(0, "false-start?")],
    "try it": [(0, "false-start?")],
    "es espera": [(0, "false-start?")],
    "aside sorry": [(0, "retake?")],
    "aside okay again": [(0, "retake?")],
    "aside es": [(0, "retake?")],
    "block B' low ratio same clip": [(0, "retake?"), (1, "retake?")],
    "block story called": [(0, "retake?"), (1, "retake?")],
    "block tutorial two songs": [(0, "retake?"), (1, "retake?")],
    "block reworded B' (insert)": [(0, "retake?"), (1, "retake?")],
    "come on": [(0, "restart?")],
    "quoted chant": [(0, "repeat?")],
    "i love it": [(0, "repeat?")],
    "the thing is": [(0, "repeat?")],
    "fr restart": [(0, "repeat?")],
    "p4 tut retake reword gonna": [(0, "retake?")],
    "p4 tut retake numbers": [(0, "retake?")],
    "p4 vlog retake intro": [(0, "retake?")],
    "p4 vlog tired": [(0, "retake?")],
    "p4 pitch retake company name": [(0, "false-start?")],
    "p4 pitch emphasis": [(0, "retake?")],
    "p4 int retake pause": [(0, "false-start?")],
    "p4 pod laugh": [(0, "false-start?")],
    "p4 es retake": [(0, "retake?")],
    "p4 fr retake": [(0, "retake?")],
    "p4 de retake": [(0, "retake?")],
    "p4 pt retake": [(0, "retake?")],
    "p4 pod retake whole answer w/ pause": [(0, "retake?")],
    "p4 pod real retake 2 apart": [(0, "retake?")],
    "p4 open tail differs across clips": [(0, "retake?")],
    "p4 comma tail differs across clips": [(0, "retake?")],
    "p4 ellipsis tail differs": [(0, "false-start?")],
    "p4 longer ellipsis take then shorter": [(0, "retake?")],
    "p4 longer dash take then shorter": [(0, "retake?")],
    "p4 es longer ellipsis": [(0, "retake?")],
    "p4 open longer then shorter across clips": [(0, "retake?")],
}
SUGGESTED = {k: v for k, v in SUGGESTED.items() if v}

# What the engine cuts for sure: the same words said again (REPEAT_MIN tokens or more), a take broken off and
# said again in full. (texts, kept text)
SURE_CUT = {
    "identical retake": (["This place is unreal.", "This place is unreal."], ["This place is unreal."]),
    "es identical retake": (["Bienvenidos a mi canal.", "Bienvenidos a mi canal."], ["Bienvenidos a mi canal."]),
    "restart mid-word": (["You can drag the cl- you can drag the clip onto the timeline."],
                         ["you can drag the clip onto the timeline."]),
    "restart mid-word 2": (["This is the be- this is the best tool I've used."], ["this is the best tool I've used."]),
    "fr restart after a pause": (["Donc on va, | donc on va ouvrir le projet."], ["donc on va ouvrir le projet."]),
    "a stutter after a pause": (["The thing is | the thing is hard to explain."], ["the thing is hard to explain."]),
    # pass 4
    "p4 tut real stutter dash": (["Click the — click the export button."],
        ["click the export button."]),
    "p4 tut cut-off then full": (["So what you want to do is", "So what you want to do is open the inspector."],
        ["So what you want to do is open the inspector."]),
    "p4 story identical twice comma pause": (["He ran, | he ran, | he ran as fast as he could."],
        ["he ran as fast as he could."]),
    "p4 es cut-off retake": (["Lo que tienes que hacer es", "Lo que tienes que hacer es abrir la app."],
        ["Lo que tienes que hacer es abrir la app."]),
    "p4 pt cut-off": (["O que você precisa fazer é", "O que você precisa fazer é abrir o app."],
        ["O que você precisa fazer é abrir o app."]),
    "p4 block 3 identical": (["Hi I'm Sam.", "I make videos.", "Welcome to my channel.", "Hi I'm Sam.", "I make videos.", "Welcome to my channel."],
        ["Hi I'm Sam.", "I make videos.", "Welcome to my channel."]),
    "p4 refrain chorus identical 3 tokens": (["We will rise.", "We will fight.", "We will rise.", "We will fight."],
        ["We will rise.", "We will fight."]),
    "p4 dash as own token": (["You want to — you want to open the inspector."],
        ["you want to open the inspector."]),
    "p4 ellipsis own token": (["So the next ... so the next step is export."],
        ["so the next step is export."]),
    "p4 prefix nopunct pause plural": (["Add the effect | add the effects panel to the right."],
        ["add the effects panel to the right."]),
    "p4 prefix cut-off nopunct": (["You can drag the cl you can drag the clip onto the timeline."],
        ["you can drag the clip onto the timeline."]),
    "p4 q then same q": (["Does it work?", "Does it work?"],
        ["Does it work?"]),
    "p4 exclaim twice": (["This is amazing!", "This is amazing!"],
        ["This is amazing!"]),
    "p4 same line diff clips adjacent": (["Thanks for watching.", "##", "Thanks for watching."],
        ["Thanks for watching."]),
    "p4 chant !": (["One more song!", "One more song!", "One more song!"],
        ["One more song!"]),
    "p4 es stutter ellipsis": (["Es que... es que no sé qué decir."],
        ["es que no sé qué decir."]),
    "p4 fr stutter dash": (["Alors on — alors on commence."],
        ["alors on commence."]),
    "p4 de Satzanfang pause": (["Und dann, | und dann kam der Regen."],
        ["und dann kam der Regen."]),
    "p4 pt pausa repeticao": (["Eu acho que, | eu acho que sim."],
        ["eu acho que sim."]),
    "truncated take": (["Montaj is the fastest way to |", "Montaj is the fastest way to edit any video."],
                       ["Montaj is the fastest way to edit any video."]),
    "full re-record across clips": (["##", "Hi, I'm Sam.", "This is my studio.", "I make videos here every", "##",
                                     "Hi, I'm Sam.", "This is my studio.", "I make videos here every single day."],
                                    ["Hi, I'm Sam.", "This is my studio.", "I make videos here every single day."]),
    "ellipsis then in full": (["And then...", "And then the lights went out."], ["And then the lights went out."]),
    "ellipsis trail": (["I waited...", "I waited for hours."], ["I waited for hours."]),
}



@pytest.mark.parametrize("name", sorted(NEVER_CUT))
def test_never_cut(name):
    texts = NEVER_CUT[name]
    us = units(*texts)
    sel = select(us, is_filler)
    assert kept_text(us, sel) == plain(texts), name
    assert sel.losers == [] and sel.abandoned == [] and sel.drop == {}


@pytest.mark.parametrize("name", sorted(SUGGESTED))
def test_a_real_retake_is_suggested_not_cut(name):
    texts = NEVER_CUT[name]
    sel = select(units(*texts), is_filler)
    got = {(i, w) for i, _, w in sel.suggest}
    assert set(SUGGESTED[name]) <= got, (name, got)


@pytest.mark.parametrize("name", sorted(SURE_CUT))
def test_only_what_is_certain_is_cut(name):
    texts, kept = SURE_CUT[name]
    us = units(*texts)
    sel = select(us, is_filler)
    assert kept_text(us, sel) == kept, name


def test_a_clause_said_again_is_cut_only_after_a_break():
    """Word for word with no break signal is emphasis (kept, suggested); after a pause it is a stutter (cut)."""
    text = "never give up, never give up, never give up on your dream"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == [text] and [w for _, _, w in sel.suggest] == ["repeat?"]
    paused = "never give up, | never give up, | never give up on your dream"
    us = units(paused)
    sel = select(us, is_filler)
    assert kept_text(us, sel) == ["never give up on your dream"]


def test_a_cut_off_word_retake_is_cut():
    text = "and always on mo- and always on mode called Kyros"
    sel = select(units(text), is_filler)
    assert kept_text([text], sel) == ["and always on mode called Kyros"]


def test_an_abandoned_opening_needs_a_break_before_the_new_sentence():
    texts = ["Then drag it onto the timeline.", "Then drag it onto Trim the start so it opens on the action."]
    no_break = select(units(*texts), is_filler)
    assert kept_text(texts, no_break) == texts
    assert no_break.suggest == []
    us = units(*texts)
    us[1].breaks = {4}
    sel = select(us, is_filler)
    assert kept_text(texts, sel) == texts and [w for _, _, w in sel.suggest] == ["abandoned?"]


def test_a_line_far_away_in_another_clip_is_left_alone():
    us = [Unit(LINES[0].split(), clip="A"), *[Unit(t.split(), clip="A") for t in FILLERS], Unit(LINES[0].split(), clip="B")]
    sel = select(us, is_filler)
    assert sel.kept == list(range(len(us))) and sel.losers == []


def test_a_clip_kept_whole_takes_no_part():
    """B1: units of a clip kept whole (b-roll) are never a take, a loser or a suggestion."""
    us = units("Thanks for watching!", "Thanks for watching!")
    us[1].fixed = True
    sel = select(us, is_filler)
    assert sel.kept == [0, 1] and sel.losers == [] and sel.suggest == []
    us = units("Thanks for watching!", "Thanks for watching!")
    us[0].fixed = True
    sel = select(us, is_filler)
    assert sel.kept == [0, 1] and sel.losers == [] and sel.suggest == []


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

