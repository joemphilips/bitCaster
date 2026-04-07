using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// Thread-safe pool of unique, valid BIP-39 12-word mnemonics for E2E tests.
/// Each call to Get() returns the next mnemonic so parallel tests never collide.
/// </summary>
public static class TestMnemonics
{
    // All entries are valid BIP-39 12-word English mnemonics with correct checksums.
    private static readonly string[] Pool =
    [
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
        "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong",
        "legal winner thank year wave sausage worth useful legal winner thank yellow",
        "letter advice cage absurd amount doctor acoustic avoid letter advice cage above",
        "ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic",
        "eye survey guilt napkin crystal cup whisper salt luggage manage unveil loyal",
        "cattle gold bind busy sound reduce tone addict baby spend february strategy",
        "half depart obvious quality work element tank gorilla view sugar picture humble",
        "seat balcony leader corn dragon vehicle report car book wear ring bus",
        "tray fluid rubber caught pause keen slice caution similar access beef attitude",
        "vessel ladder alter error federal sibling chat ability sun glass valve picture",
        "scheme spot photo card baby mountain device kick cradle pact join borrow",
        "cable inject sheriff boil unit web rural manual stool boss summer sausage",
        "antique brush concert promote vibrant vacuum crash taxi equip hover apart allow",
        "kiwi post sad banner harbor same zoo ancient document illegal half divide",
        "pen oval crime render wedding club sunny such jazz program tube crush",
        "bright execute bronze between pulp ticket mule approve click photo cradle skirt",
        "bar reduce enable music weird powder abandon doctor wrap risk yellow comfort",
        "glide crack sure alcohol fuel sound mass cave august expect body critic",
        "target switch home forum vote level clay rotate regular arrive orient squeeze",
        "trash cheese elder before story penalty hello viable style intact noble depth",
        "arrive lava rule exchange case boost catalog chef pond praise fat bench",
        "square organ aim local gold risk disorder fit equip keep glow decade",
        "style wash hockey bird sorry patient focus bike crime secret palace elephant",
        "chimney almost mystery unveil timber dawn almost congress either waste unknown hope",
        "stand hurry pencil carpet buffalo cruise payment vast disorder live diary paper",
        "rich walnut erode imitate deliver during token alarm equal term popular easily",
        "protect food dirt autumn treat hope hip vibrant wide occur setup fault",
        "mango turn odor save rookie addict merit usage frog settle spell vintage",
        "else glory exercise rough method ignore excess please siege loud pattern ready",
        "help sniff electric drama fall mean embark blue lazy fashion twin spawn",
        "book better quote rigid genius deer base sight sell oven candy laundry",
        "brother nose submit bar pepper broccoli normal boil pumpkin census asthma unveil",
        "axis gallery surround cross often lawn urban fish thing left scout mention",
        "vast depend update tribe oil sniff evil chapter veteran balcony biology marble",
        "indoor theme refuse column degree advance heart snap cause skull genuine vibrant",
        "soft ride insect hidden enforce assist modify visual pink quick athlete glimpse",
        "film enrich day divorce party idle woman rookie cram jewel slow bean",
        "emerge sugar try february brief caught leaf humble feel coyote choice canyon",
        "enrich stand federal gallery moment swarm fitness stool ignore limb excite rack",
        "history pipe clap slim decade sphere cave asset sentence circle cliff order",
        "scare color stairs enhance under fury bulk vote critic siren oppose prepare",
        "plastic circle question cost afraid lens setup during essence gospel expect bar",
        "exist deliver midnight summer certain thunder exercise alley mix seven upon must",
        "deal skirt resource liberty visual antenna admit shed bring seek clean marine",
        "peace play gold lens evidence bean absurd analyst infant business select wrap",
        "napkin pole bicycle filter train forward autumn rescue soup sphere estate reward",
        "educate sample salmon refuse culture mom orient security mango upset bread walk",
        "loud congress bitter blade harvest left trouble cost flush kind evoke easy",
        "spread among kid cable floor artist turtle lamp rice casual nephew elder",
        "assume treat tourist arch venue drama derive tilt can fitness hedgehog buzz",
        "eye day awesome casual earth jump doll suggest bus canvas travel budget",
        "either already sign border tomorrow mushroom pepper squirrel nose fashion mirror canyon",
        "virus boost trap bronze patient menu buzz tomato grace tape shove vicious",
        "toddler weather steel argue hope six deal bonus advance document april display",
        "agree wink when blame seven valid shadow useless treat reason valley finish",
        "decide purchase patch around myth offer subject marriage common dumb later wisdom",
        "arena palm fire act cart book tail bird orient hint elder outside",
        "nuclear gaze veteran under throw visa extend very broom knee settle travel",
        "library table phrase insect hundred blouse divorce collect riot observe green couch",
        "prepare chair jump mushroom velvet hazard mask trim very hazard absent mosquito",
        "price chicken oxygen suggest chat wage yellow dentist snack disagree joke speak",
        "crime ice enough price ecology border devote prosper thunder galaxy rubber dizzy",
        "rail diagram brown wet wrong depart puzzle clump punch citizen fluid rocket",
        "wear lens fantasy autumn grab arena hundred fix congress shiver february decrease",
        "town foam fork swallow prize afraid party birth spy crack beauty gentle",
        "option chuckle dentist dress soup uniform race fever family travel cattle real",
        "badge foot genuine cross brave correct mixture useful theme give eight mass",
        "shock either trumpet loop gap flame acquire decorate brass visa easy enact",
        "ignore east enjoy raise extra museum object mention cupboard remove damage silver",
        "swamp digital spoon afford bag observe piece swap curious slot three tumble",
        "ankle worth guess wire able dolphin liar enhance cat focus napkin salmon",
        "vehicle stomach dinosaur vacuum course inside floor jealous caution sorry this side",
        "planet describe pudding sense tent swallow another machine garment someone bubble adjust",
        "primary excite submit force pole develop crew emotion toward funny chapter puzzle",
        "wear baby glare holiday person file meadow vast gospel derive later patch",
        "phrase picnic aim farm purchase seed thank juice swear deposit drift fish",
        "buddy copy now offer critic robust zebra approve ring veteran join gauge",
        "pipe treat distance sell vacuum ill outside chronic sort sketch scorpion language",
        "fly pig plastic behind lunch vendor student script expand step bargain wedding",
        "extend chalk ahead fiction fuel siege chief spell bubble corn note mesh",
        "left pottery measure crumble eager judge art pattern pink dune task popular",
        "pole vessel stamp ginger series language nerve giggle chat rescue tattoo regret",
        "lonely coach path travel stand fiscal catalog beauty trend salt isolate basket",
        "aim panda task beauty lyrics what loan peace slender install sunset october",
        "fat valve aware fiction bundle come critic urban early funny install price",
        "celery rifle vendor you deposit rude ribbon exclude nature mom scrap soap",
        "because pear today online wave invest brain draw assist upset spawn wrap",
        "obscure weird agent already setup honey gym extra dirt accident one jeans",
        "health dice grunt unfold amazing hammer limb nothing mail problem pyramid bottom",
        "draw result glance kick federal dry curve session basket royal reunion fatigue",
        "chuckle cool near again relief box rose abuse meadow copy loud stone",
        "material since small picture final junk outside myth talent wheat bid curve",
        "foster erosion angry faith mad decrease lady dove benefit unlock dinner bring",
        "letter loyal awake inhale bachelor acquire asthma mom leaf unable sentence genuine",
        "surge front saddle brown genius hat walnut sweet crystal call pulp frame",
        "usual gift sponsor canoe host destroy blouse journey claw quick push someone",
        "source stick route slice ride bargain eternal blade muffin stairs gossip brief",
        "museum bunker explain program iron author impact much few hello auction glove",
        "first wisdom differ myself scheme wood skill dream desert coyote penalty eyebrow",
        "poem hat current movie brain resist dust upper obscure detect ceiling train",
        "pulp cream garment voyage knock rude clay vocal naive must unusual cheap",
        "cabin soup carpet path title excuse lady know duty era table idea",
        "release three divert adult actor point wise six zone various during casual",
        "raise advice behave north obey topple body nuclear rich van crisp credit",
        "gossip mimic buyer attract grunt thrive resource exercise pepper length iron clerk",
        "also captain fox trim neglect exhaust click session initial fluid laundry average",
        "boost logic couch banana album ribbon toward vicious fee leopard credit thrive",
        "cost velvet field picture spin capable fashion monitor until palm city clown",
        "vendor flight toe bind attract valley prosper clutch physical mosquito thing fragile",
        "fat vast few affair youth path during idle bridge click affair hair",
        "visa economy replace exercise speak cool wisdom siren express brother grunt this",
        "panda among april join fun winner bring company giggle advance boss stone",
        "domain tonight access tent market guess sniff lens usage shock couch wear",
        "pill student time ocean tragic sail valley swift educate route cabbage task",
        "impulse submit safe inherit super remember echo scene later excuse parade lazy",
        "neutral magnet fold spare jeans fun want cross patch awful target mango",
        "rival fix cat arena practice sight arena velvet bring fatigue barrel evoke",
        "gas lend dignity narrow reunion reunion smooth vessel area unveil actor grain",
        "grid strong latin pioneer satoshi fox artwork gravity family gravity mixture torch",
        "steel shoe fashion sick sketch legal blind vapor lyrics width stand cruel",
        "left toast proof bomb correct coyote ceiling other analyst repeat transfer gap",
        "river private kitchen clown reject skull answer useful unhappy wheel addict penalty",
        "shift neck floor bunker concert brisk soccer orbit matter song uncover smart",
    ];

    private static int _counter = -1;

    /// <summary>
    /// Get a unique mnemonic. Thread-safe; each call returns the next in the pool.
    /// </summary>
    public static string Get()
    {
        var index = Interlocked.Increment(ref _counter);
        if (index >= Pool.Length)
            throw new InvalidOperationException(
                $"TestMnemonics pool exhausted ({Pool.Length} mnemonics). Add more to TestHelpers.cs.");
        return Pool[index];
    }

    /// <summary>
    /// Get two unique mnemonics (e.g., for interop tests needing separate wallets).
    /// </summary>
    public static (string First, string Second) GetPair() => (Get(), Get());
}

/// <summary>
/// Shared helpers for E2E tests. Extracted to avoid duplication across test classes.
/// </summary>
public static class TestHelpers
{
    /// <summary>
    /// Attach console and page error capture to a page, returning the shared message list.
    /// </summary>
    public static List<string> AttachConsoleCapture(IPage page)
    {
        var messages = new List<string>();
        page.Console += (_, msg) => messages.Add($"[{msg.Type}] {msg.Text}");
        page.PageError += (_, error) => messages.Add($"[PAGE_ERROR] {error}");
        return messages;
    }

    /// <summary>
    /// Build a diagnostic exception with page state for CI debugging.
    /// </summary>
    public static async Task<Exception> BuildDiagnosticExceptionAsync(
        IPage page, IReadOnlyList<string> consoleMessages, string context)
    {
        string? errorBanner = null;
        try { errorBanner = await page.Locator(".bg-red-900").TextContentAsync(new() { Timeout = 1_000 }); }
        catch { /* no error banner visible */ }

        var bodyText = await page.Locator("body").InnerTextAsync(new() { Timeout = 5_000 });
        var url = page.Url;

        return new Exception(
            $"{context}\n" +
            $"URL: {url}\n" +
            $"Error banner: {errorBanner ?? "(none)"}\n" +
            $"Console ({consoleMessages.Count} messages):\n{string.Join("\n", consoleMessages.TakeLast(30))}\n" +
            $"Page text (first 2000 chars): {bodyText[..Math.Min(bodyText.Length, 2000)]}");
    }

    /// <summary>
    /// Inject localStorage so wallet is set up (no mint connection).
    /// Use this for tests that only need setupComplete=true without a real mint URL.
    /// </summary>
    public static async Task SetupComplete(IPage page, int vitePort)
    {
        var mnemonic = TestMnemonics.Get();
        await page.GotoAsync($"http://localhost:{vitePort}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    mints: [],
                    activeMintUrl: 'http://localhost:3338',
                    keysetCounters: {{}}
                }},
                version: 0
            }}));
        ");
    }

    /// <summary>
    /// Poll a URL until it returns a success status code (30-second timeout).
    /// </summary>
    public static async Task WaitForService(HttpClient httpClient, string url, string serviceName)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                var response = await httpClient.GetAsync(url);
                if (response.IsSuccessStatusCode)
                    return;
            }
            catch
            {
                // Not ready yet
            }
            await Task.Delay(TimeSpan.FromSeconds(1));
        }

        throw new InvalidOperationException(
            $"{serviceName} is not reachable at {url}. " +
            "Start all services before running E2E tests. See AGENTS.md for the 3-terminal workflow.");
    }
}
