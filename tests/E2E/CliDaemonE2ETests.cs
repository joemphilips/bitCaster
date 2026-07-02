using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Playwright;
using NBitcoin;

namespace BitCaster.E2ETest;

/// <summary>
/// E2E coverage for the browserless frontend path introduced by P19. The test
/// starts a real bitcaster-daemon process, drives it only through
/// bitcaster-cli, and points it at the same public mock engine used by browser
/// E2E.
/// </summary>
[Collection(E2ECollections.LiveServiceMutation)] // Starts daemon processes and mutates shared engine/mint state.
public sealed class CliDaemonE2ETests : IAsyncLifetime
{
    private const int MintInputFeePpk = 1;
    private const int SatShareFaceSubunits = 1_000_000;
    private static readonly JsonSerializerOptions BrowserDiagnosticJsonOptions = new()
    {
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
    };

    private readonly string _repoRoot = FindRepoRoot();
    private readonly List<DaemonHandle> _daemons = [];

    private static string NewConditionId()
    {
        var random = $"{Guid.NewGuid():N}{Guid.NewGuid():N}";
        return $"11{random[2..]}";
    }

    public enum TradingClientKind
    {
        Cli,
        Gui,
    }

    public async Task InitializeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        await TestHelpers.WaitForService(
            httpClient,
            $"{TestPorts.ServerUrl}/health",
            "Matching Engine");
    }

    [Fact]
    public async Task Cli_SubmitAndStatus_RoundTripThroughDaemonAndMockEngine()
    {
        var daemon = await StartDaemonAsync();
        var marketId = $"{NewConditionId()}-Yes";

        using var submit = await RunCliJsonAsync(daemon, [
            "order",
            "submit",
            marketId,
            "Yes",
            "Buy",
            "50",
            "100",
            "GTC",
            "--no-preflight-split",
        ]);

        Assert.True(submit.RootElement.GetProperty("ok").GetBoolean());
        var engine = submit.RootElement.GetProperty("result").GetProperty("engine");
        var local = submit.RootElement.GetProperty("result").GetProperty("local");
        var orderId = engine.GetProperty("orderId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(orderId));
        Assert.Equal(orderId, local.GetProperty("orderId").GetString());
        Assert.Equal(marketId, local.GetProperty("marketId").GetString());
        Assert.Matches(
            "^(02|03)[0-9a-f]{64}$",
            engine.GetProperty("ephemeralPubkey").GetString()!);

        using var status = await RunCliJsonAsync(daemon, [
            "order",
            "status",
            marketId,
            orderId!,
        ]);

        Assert.True(status.RootElement.GetProperty("ok").GetBoolean());
        var statusEngine = status.RootElement.GetProperty("result").GetProperty("engine");
        Assert.Equal(orderId, statusEngine.GetProperty("orderId").GetString());
        Assert.Equal("resting", statusEngine.GetProperty("status").GetString());
        Assert.Equal(100, statusEngine.GetProperty("remainingAmountSubunits").GetInt32());

        using var book = await RunCliJsonAsync(daemon, [
            "order",
            "book",
            marketId,
        ]);
        Assert.True(book.RootElement.GetProperty("ok").GetBoolean());
        var bookResult = book.RootElement.GetProperty("result");
        Assert.Equal(marketId, bookResult.GetProperty("marketId").GetString());
        var bid = Assert.Single(bookResult.GetProperty("bids").EnumerateArray());
        Assert.Equal(50, bid.GetProperty("price").GetInt32());
        Assert.Equal(100, bid.GetProperty("amount").GetInt32());
        Assert.Empty(bookResult.GetProperty("asks").EnumerateArray());

        using var cancel = await RunCliJsonAsync(daemon, [
            "order",
            "cancel",
            marketId,
            orderId!,
        ]);
        Assert.True(cancel.RootElement.GetProperty("ok").GetBoolean());
        Assert.True(cancel.RootElement
            .GetProperty("result")
            .GetProperty("cancelled")
            .GetBoolean());

        using var cancelledStatus = await RunCliJsonAsync(daemon, [
            "order",
            "status",
            marketId,
            orderId!,
        ]);
        Assert.True(cancelledStatus.RootElement.GetProperty("ok").GetBoolean());
        var cancelledEngine = cancelledStatus.RootElement.GetProperty("result").GetProperty("engine");
        Assert.Equal("cancelled", cancelledEngine.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Cli_ComplementaryBuyMatch_WakesRestingMakerAndCarriesSettlementMetadata()
    {
        var maker = await StartDaemonAsync();
        var taker = await StartDaemonAsync();
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateBinaryMarketFixtureAsync(
            httpClient,
            titlePrefix: "E2E binary complement");
        var noMarketId = $"{condition.ConditionId}-{condition.NoOutcomeSetId}";
        var yesMarketId = $"{condition.ConditionId}-{condition.YesOutcomeSetId}";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            noMarketId,
            condition.NoOutcomeSetId,
            "Buy",
            "55",
            "100",
            "GTC",
            "--no-preflight-split",
        ]);

        Assert.True(makerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var makerOrderId = makerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine")
            .GetProperty("orderId")
            .GetString();
        Assert.False(string.IsNullOrWhiteSpace(makerOrderId));

        using var takerSubmit = await RunCliJsonAsync(taker, [
            "order",
            "submit",
            yesMarketId,
            condition.YesOutcomeSetId,
            "Buy",
            "50",
            "100",
            "FAK",
        ]);

        Assert.True(takerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var takerEngine = takerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        var fill = Assert.Single(takerEngine.GetProperty("fills").EnumerateArray());
        var tradeId = fill.GetProperty("tradeId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(tradeId));
        Assert.Equal("Mint", fill.GetProperty("path").GetString());
        Assert.Equal("Mint", fill.GetProperty("settlementKind").GetString());
        Assert.Equal(100, fill.GetProperty("outcomeFaceAmountSubunits").GetInt32());
        Assert.Equal(50, fill.GetProperty("quotePaymentSats").GetInt32());
        Assert.Equal(condition.NoOutcomeSetId, fill.GetProperty("sellerKeepOutcomeSetId").GetString());
        Assert.Equal(condition.YesOutcomeSetId, fill.GetProperty("sellerLockOutcomeSetId").GetString());
        Assert.Equal(0, takerEngine.GetProperty("remainingAmountSubunits").GetInt32());

        using var makerTrade = await WaitForTradeRecordAsync(
            maker,
            tradeId!,
            record => HasMintMetadata(
                record,
                noMarketId,
                expectedRole: "seller",
                sellerKeepOutcomeSetId: condition.NoOutcomeSetId,
                sellerLockOutcomeSetId: condition.YesOutcomeSetId,
                outcomeFaceAmountSubunits: 100,
                quotePaymentSats: 50),
            "resting maker mint TradeCreated");
        using var takerTrade = await WaitForTradeRecordAsync(
            taker,
            tradeId!,
            record => HasMintMetadata(
                record,
                yesMarketId,
                expectedRole: "buyer",
                sellerKeepOutcomeSetId: condition.NoOutcomeSetId,
                sellerLockOutcomeSetId: condition.YesOutcomeSetId,
                outcomeFaceAmountSubunits: 100,
                quotePaymentSats: 50),
            "incoming taker mint TradeCreated");

        Assert.Equal(makerOrderId, makerTrade.RootElement
            .GetProperty("result")
            .GetProperty("orderId")
            .GetString());
        Assert.Equal("buyer", takerTrade.RootElement
            .GetProperty("result")
            .GetProperty("role")
            .GetString());
    }

    [Fact]
    public async Task Cli_CategoricalComplementaryBuyMatch_CarriesOutcomeSetMetadata()
    {
        var maker = await StartDaemonAsync();
        var taker = await StartDaemonAsync();
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            outcomes: ["Alice", "Bob", "Carol"],
            titlePrefix: "E2E categorical complement");
        var conditionId = condition.ConditionId;
        const string makerOutcomeSetId = "Bob|Carol";
        const string takerOutcomeSetId = "Alice";
        var makerMarketId = $"{conditionId}-{takerOutcomeSetId}";
        var takerMarketId = $"{conditionId}-{takerOutcomeSetId}";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            takerOutcomeSetId,
            "Buy",
            "60",
            "100",
            "GTC",
            "--token-side",
            "Complement",
            "--no-preflight-split",
        ]);

        Assert.True(makerSubmit.RootElement.GetProperty("ok").GetBoolean());

        using var takerSubmit = await RunCliJsonAsync(taker, [
            "order",
            "submit",
            takerMarketId,
            takerOutcomeSetId,
            "Buy",
            "45",
            "100",
            "FAK",
        ]);

        Assert.True(takerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var takerEngine = takerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        var fill = Assert.Single(takerEngine.GetProperty("fills").EnumerateArray());
        var tradeId = fill.GetProperty("tradeId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(tradeId));
        Assert.Equal("Mint", fill.GetProperty("path").GetString());
        Assert.Equal("Mint", fill.GetProperty("settlementKind").GetString());
        Assert.Equal(100, fill.GetProperty("outcomeFaceAmountSubunits").GetInt32());
        Assert.Equal(45, fill.GetProperty("quotePaymentSats").GetInt32());
        Assert.Equal(makerOutcomeSetId, fill.GetProperty("sellerKeepOutcomeSetId").GetString());
        Assert.Equal(takerOutcomeSetId, fill.GetProperty("sellerLockOutcomeSetId").GetString());
        Assert.Equal(0, takerEngine.GetProperty("remainingAmountSubunits").GetInt32());

        using var makerTrade = await WaitForTradeRecordAsync(
            maker,
            tradeId!,
            record => HasMintMetadata(
                record,
                takerMarketId,
                expectedRole: "seller",
                sellerKeepOutcomeSetId: makerOutcomeSetId,
                sellerLockOutcomeSetId: takerOutcomeSetId,
                outcomeFaceAmountSubunits: 100,
                quotePaymentSats: 45),
            "categorical resting maker mint TradeCreated");
        using var takerTrade = await WaitForTradeRecordAsync(
            taker,
            tradeId!,
            record => HasMintMetadata(
                record,
                takerMarketId,
                expectedRole: "buyer",
                sellerKeepOutcomeSetId: makerOutcomeSetId,
                sellerLockOutcomeSetId: takerOutcomeSetId,
                outcomeFaceAmountSubunits: 100,
                quotePaymentSats: 45),
            "categorical incoming taker mint TradeCreated");

        Assert.Equal("seller", makerTrade.RootElement
            .GetProperty("result")
            .GetProperty("role")
            .GetString());
        Assert.Equal("buyer", takerTrade.RootElement
            .GetProperty("result")
            .GetProperty("role")
            .GetString());
    }

    [Fact]
    public async Task Cli_CategoricalOverlappingBuySets_DoNotMatchAsComplements()
    {
        var maker = await StartDaemonAsync();
        var taker = await StartDaemonAsync();
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            outcomes: ["Alice", "Bob", "Carol"],
            titlePrefix: "E2E categorical overlap");
        var conditionId = condition.ConditionId;
        const string makerPrimitiveOutcomeSetId = "Alice";
        const string takerOutcomeSetId = "Bob";
        var makerMarketId = $"{conditionId}-{makerPrimitiveOutcomeSetId}";
        var takerMarketId = $"{conditionId}-{takerOutcomeSetId}";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            makerPrimitiveOutcomeSetId,
            "Buy",
            "60",
            "100",
            "GTC",
            "--token-side",
            "Complement",
            "--no-preflight-split",
        ]);
        Assert.True(makerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var makerOrderId = makerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine")
            .GetProperty("orderId")
            .GetString();
        Assert.False(string.IsNullOrWhiteSpace(makerOrderId));

        using var takerSubmit = await RunCliJsonAsync(taker, [
            "order",
            "submit",
            takerMarketId,
            takerOutcomeSetId,
            "Buy",
            "45",
            "100",
            "FAK",
        ]);

        Assert.True(takerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var takerEngine = takerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        Assert.Empty(takerEngine.GetProperty("fills").EnumerateArray());
        Assert.Equal("cancelled", takerEngine.GetProperty("status").GetString());
        Assert.Equal(100, takerEngine.GetProperty("remainingAmountSubunits").GetInt32());

        using var makerStatus = await RunCliJsonAsync(maker, [
            "order",
            "status",
            makerMarketId,
            makerOrderId!,
        ]);
        Assert.True(makerStatus.RootElement.GetProperty("ok").GetBoolean());
        var makerEngine = makerStatus.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        Assert.Equal("resting", makerEngine.GetProperty("status").GetString());
        Assert.Equal(100, makerEngine.GetProperty("remainingAmountSubunits").GetInt32());
        Assert.Empty(makerEngine.GetProperty("fills").EnumerateArray());
    }

    [Theory]
    [InlineData(TradingClientKind.Cli, TradingClientKind.Cli, true)]
    [InlineData(TradingClientKind.Cli, TradingClientKind.Cli, false)]
    [InlineData(TradingClientKind.Gui, TradingClientKind.Cli, true)]
    [InlineData(TradingClientKind.Gui, TradingClientKind.Cli, false)]
    [InlineData(TradingClientKind.Cli, TradingClientKind.Gui, true)]
    [InlineData(TradingClientKind.Cli, TradingClientKind.Gui, false)]
    [InlineData(TradingClientKind.Gui, TradingClientKind.Gui, true)]
    [InlineData(TradingClientKind.Gui, TradingClientKind.Gui, false)]
    public async Task ComplementaryBuySettlement_Matrix(
        TradingClientKind makerKind,
        TradingClientKind takerKind,
        bool makerPreflightSplit)
    {
        var condition = await FindBinaryConditionAsync();
        var makerOutcomeSetId = condition.YesOutcomeSetId;
        var takerOutcomeSetId = condition.NoOutcomeSetId;
        var makerMarketId = $"{condition.ConditionId}-{makerOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{takerOutcomeSetId}";
        const int faceAmountSubunits = 100;
        const int makerFundingSats = 210;
        const int makerPrice = 1;
        const int takerPrice = 99;
        var expectedSpendableOutcomeSats = SpendableCtfSats(faceAmountSubunits);

        var playwright = makerKind == TradingClientKind.Gui || takerKind == TradingClientKind.Gui
            ? await Playwright.CreateAsync()
            : null;
        IBrowser? browser = null;

        try
        {
            if (playwright is not null)
            {
                browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
                {
                    Headless = true,
                });
            }

            var maker = await CreateTradingClientAsync(
                makerKind,
                browser,
                "66".PadRight(64, '6'));
            var taker = await CreateTradingClientAsync(
                takerKind,
                browser,
                "77".PadRight(64, '7'));

            await maker.FundSatsAsync(makerFundingSats);
            await taker.FundSatsAsync(faceAmountSubunits);

            var makerOrderId = await maker.SubmitRestingComplementaryMakerBuyAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                makerMarketId,
                makerPrice,
                faceAmountSubunits,
                makerPreflightSplit);
            await WaitForEngineBidAsync(makerMarketId, faceAmountSubunits);
            if (makerPreflightSplit)
            {
                await maker.AssertReservedOutcomeProofsAsync(
                    condition.ConditionId,
                    makerOutcomeSetId,
                    expectedSpendableOutcomeSats);
                await maker.AssertReservedOutcomeProofsAsync(
                    condition.ConditionId,
                    takerOutcomeSetId,
                    expectedSpendableOutcomeSats);
            }

            var tradeId = await taker.SubmitComplementaryTakerBuyAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                takerMarketId,
                takerPrice,
                faceAmountSubunits);

            await maker.RefreshMatchedOrderAsync(makerMarketId, makerOrderId, tradeId);
            await maker.WaitConfirmedAsync(tradeId);
            await taker.WaitConfirmedAsync(tradeId);

            await maker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                expectedSpendableOutcomeSats);
            await taker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                expectedSpendableOutcomeSats);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright?.Dispose();
        }
    }

    [Fact]
    public async Task BrowserMaker_CliTaker_CategoricalComplementarySettlement_UsesPrimitiveProofMetadata()
    {
        using var fixtureHttpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            fixtureHttpClient,
            titlePrefix: "E2E categorical complementary");
        var takerOutcomeSetId = condition.PrimitiveOutcomeSetIds[0];
        var makerOutcomeSetId = CanonicalOutcomeSet(condition.PrimitiveOutcomeSetIds.Skip(1));
        var makerMarketId = $"{condition.ConditionId}-{takerOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{takerOutcomeSetId}";
        const int faceAmountSubunits = 100;
        const int makerFundingSats = 210;
        const int makerPrice = 1;
        const int takerPrice = 99;
        var expectedSpendableOutcomeSats = SpendableCtfSats(faceAmountSubunits);

        var playwright = await Playwright.CreateAsync();
        IBrowser? browser = null;
        try
        {
            browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });

            var maker = await CreateTradingClientAsync(
                TradingClientKind.Gui,
                browser,
                "88".PadRight(64, '8'));
            var taker = await CreateTradingClientAsync(
                TradingClientKind.Cli,
                null,
                "99".PadRight(64, '9'));

            await maker.FundSatsAsync(makerFundingSats);
            await taker.FundSatsAsync(faceAmountSubunits);

            var makerOrderId = await maker.SubmitRestingComplementaryMakerBuyAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                makerMarketId,
                makerPrice,
                faceAmountSubunits,
                preflightSplit: true,
                displayedOutcomeSetId: takerOutcomeSetId);
            await WaitForEngineAskAsync(makerMarketId, faceAmountSubunits);

            await maker.AssertReservedOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                expectedSpendableOutcomeSats);
            await maker.AssertReservedOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                expectedSpendableOutcomeSats);

            var tradeId = await taker.SubmitComplementaryTakerBuyAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                takerMarketId,
                takerPrice,
                faceAmountSubunits);

            try
            {
                await maker.RefreshMatchedOrderAsync(makerMarketId, makerOrderId, tradeId);
                await Task.WhenAll(
                    maker.WaitConfirmedAsync(tradeId),
                    taker.WaitConfirmedAsync(tradeId));
            }
            catch (Exception ex)
            {
                throw await maker.BuildDiagnosticExceptionAsync(
                    $"Mint complementary settlement did not confirm for trade {tradeId}. Inner={ex.Message}");
            }

            await maker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                expectedSpendableOutcomeSats);
            await taker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                expectedSpendableOutcomeSats);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserMaker_PreflightSplitBoundaryBand_ShowsTopUpModalBeforeProofSelection()
    {
        using var fixtureHttpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            fixtureHttpClient,
            titlePrefix: "P28 boundary under face");
        var outcomeSetId = condition.PrimitiveOutcomeSetIds[0];
        var marketId = $"{condition.ConditionId}-{outcomeSetId}";
        const int faceAmountSubunits = 100;
        const int limitPrice = 40;
        const int makerFundingSats = 50;

        var playwright = await Playwright.CreateAsync();
        IBrowser? browser = null;
        try
        {
            browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
            {
                ServiceWorkers = ServiceWorkerPolicy.Block,
            });
            await AddSignalRDebugAsync(context);
            var page = await context.NewPageAsync();
            var consoleMessages = TestHelpers.AttachConsoleCapture(page);

            await SetupBrowserWalletAndSignerAsync(page, "cc".PadRight(64, 'c'));
            await DepositBrowserSatsAsync(page, makerFundingSats, consoleMessages);

            await SubmitBrowserLimitBuyExpectTopUpModalAsync(
                page,
                condition.ConditionId,
                outcomeSetId,
                limitPrice,
                faceAmountSubunits,
                consoleMessages);
            AssertNoForbiddenBrowserConsole(consoleMessages);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserMaker_PreflightSplitBoundaryBand_PostsWhenFundedAboveFace()
    {
        using var fixtureHttpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            fixtureHttpClient,
            titlePrefix: "P28 boundary funded");
        var outcomeSetId = condition.PrimitiveOutcomeSetIds[0];
        var marketId = $"{condition.ConditionId}-{outcomeSetId}";
        const int faceAmountSubunits = 100;
        const int limitPrice = 40;
        const int makerFundingSats = 210;

        var playwright = await Playwright.CreateAsync();
        IBrowser? browser = null;
        try
        {
            browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
            {
                ServiceWorkers = ServiceWorkerPolicy.Block,
            });
            await AddSignalRDebugAsync(context);
            var page = await context.NewPageAsync();
            var consoleMessages = TestHelpers.AttachConsoleCapture(page);

            await SetupBrowserWalletAndSignerAsync(page, "dd".PadRight(64, 'd'));
            await DepositBrowserSatsAsync(page, makerFundingSats, consoleMessages);

            await SubmitBrowserLimitBuyRestingAsync(
                page,
                condition.ConditionId,
                outcomeSetId,
                marketId,
                limitPrice,
                faceAmountSubunits,
                preflight: true,
                consoleMessages);
            await WaitForEngineBidAsync(marketId, faceAmountSubunits);
            AssertNoForbiddenBrowserConsole(consoleMessages);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task EightOutcomeMarket_PreRegistration_Produces16Keysets()
    {
        var outcomes = new[] { "A", "B", "C", "D", "E", "F", "G", "H" };
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };

        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            outcomes,
            registerEngine: false,
            titlePrefix: "WS-P2-H 8-outcome");

        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);

        var actual = ReadConditionKeysetLabels(doc, condition.ConditionId);
        var expected = RequiredOutcomeCollections(outcomes).ToHashSet(StringComparer.Ordinal);
        Assert.Equal(16, actual.Count);
        Assert.Equal(
            expected.Order(StringComparer.Ordinal).ToArray(),
            actual.Order(StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public async Task BrowserMaker_BrowserTaker_4OutcomeCompositeSwap_BobReceivesSingleCompositeToken()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            ["A", "B", "C", "D"],
            registerEngine: true,
            titlePrefix: "WS-P2-H 4-outcome composite");
        const string aliceOutcomeSetId = "A";
        var bobOutcomeSetId = ComplementOutcomeSet(condition.PrimitiveOutcomeSetIds, aliceOutcomeSetId);
        var aliceMarketId = $"{condition.ConditionId}-{aliceOutcomeSetId}";
        var bobMarketId = $"{condition.ConditionId}-{bobOutcomeSetId}";
        const int aliceAmountSats = 200;
        const int bobAmountSats = 100;
        const int price = 50;

        var playwright = await Playwright.CreateAsync();
        IBrowser? browser = null;
        try
        {
            browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            await using var aliceContext = await browser.NewContextAsync(new BrowserNewContextOptions
            {
                ServiceWorkers = ServiceWorkerPolicy.Block,
            });
            await using var bobContext = await browser.NewContextAsync(new BrowserNewContextOptions
            {
                ServiceWorkers = ServiceWorkerPolicy.Block,
            });
            await AddSignalRDebugAsync(aliceContext);
            await AddSignalRDebugAsync(bobContext);

            var alicePage = await aliceContext.NewPageAsync();
            var bobPage = await bobContext.NewPageAsync();
            var aliceConsole = TestHelpers.AttachConsoleCapture(alicePage);
            var bobConsole = TestHelpers.AttachConsoleCapture(bobPage);

            await SetupBrowserWalletAndSignerAsync(alicePage, "aa".PadRight(64, 'a'));
            await DepositBrowserSatsAsync(alicePage, (aliceAmountSats * 2) + 10, aliceConsole);
            await SubmitBrowserLimitBuyRestingAsync(
                alicePage,
                condition.ConditionId,
                aliceOutcomeSetId,
                aliceMarketId,
                price,
                aliceAmountSats,
                preflight: true,
                aliceConsole);
            await WaitForEngineBidAsync(aliceMarketId, aliceAmountSats);

            await SetupBrowserWalletAndSignerAsync(bobPage, "bb".PadRight(64, 'b'));
            await DepositBrowserSatsAsync(bobPage, bobAmountSats, bobConsole);
            var tradeId = await SubmitBrowserMarketBuyNoAsync(
                bobPage,
                condition.ConditionId,
                aliceOutcomeSetId,
                bobMarketId,
                bobAmountSats,
                bobConsole,
                limitPrice: price);

            await WaitForBrowserTradeConfirmedAsync(
                tradeId,
                [(alicePage, aliceConsole), (bobPage, bobConsole)]);
            await WaitForBrowserExactOutcomeProofsAsync(
                bobPage,
                condition.ConditionId,
                bobOutcomeSetId,
                bobConsole,
                bobAmountSats,
                availableOnly: true);
            foreach (var primitive in condition.PrimitiveOutcomeSetIds.Where(outcome => outcome != aliceOutcomeSetId))
            {
                await WaitForBrowserExactOutcomeSatsAsync(
                    bobPage,
                    condition.ConditionId,
                    primitive,
                    bobConsole,
                    expectedSats: 0,
                    availableOnly: true);
            }
            AssertNoForbiddenBrowserConsole(aliceConsole, bobConsole);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task CliConsolidate_T2_ResidualPlusCollateral()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            registerEngine: false,
            titlePrefix: "WS-P2-H consolidate T2");
        await using var fakeEngine = new FakeMarketServer(
            condition.ConditionId,
            condition.PrimitiveOutcomeSetIds,
            status: "pending");
        var daemon = await StartDaemonAsync();
        await ConfigureDaemonEngineAsync(daemon, fakeEngine.Url);
        var marketId = $"{condition.ConditionId}-{condition.PrimitiveOutcomeSetIds[0]}";

        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "B|C", amountSats: 2);
        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "A|C", amountSats: 2);

        using var result = await RunCliJsonAsync(daemon, [
            "wallet",
            "consolidate",
            marketId,
            "--strategy",
            "sweep",
        ], TimeSpan.FromSeconds(30));

        AssertConsolidationResult(
            result,
            expectedType: "t2",
            expectedCollateralReturnedSats: 1,
            ("C", 2),
            ("*", 1));
        await WaitForDaemonExactOutcomeSatsAsync(daemon, condition.ConditionId, "C", 2);
        await WaitForDaemonBaseAvailableSatsAsync(daemon, 1);
        await AssertConsolidateNonPendingMarketRefusedAsync();
    }

    [Fact]
    public async Task CliConsolidate_T1_ComplementFromSingletons()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            registerEngine: false,
            titlePrefix: "WS-P2-H consolidate T1");
        await using var fakeEngine = new FakeMarketServer(
            condition.ConditionId,
            condition.PrimitiveOutcomeSetIds,
            status: "pending");
        var daemon = await StartDaemonAsync();
        await ConfigureDaemonEngineAsync(daemon, fakeEngine.Url);
        var marketId = $"{condition.ConditionId}-{condition.PrimitiveOutcomeSetIds[0]}";

        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "A", amountSats: 2);
        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "B", amountSats: 2);
        await ReceiveSatsAsync(daemon, amountSats: 1);

        using var result = await RunCliJsonAsync(daemon, [
            "wallet",
            "consolidate",
            marketId,
            "--strategy",
            "merge",
        ], TimeSpan.FromSeconds(30));

        AssertConsolidationResult(
            result,
            expectedType: "t1",
            expectedCollateralReturnedSats: 0,
            ("A|B", 2));
        await WaitForDaemonExactOutcomeSatsAsync(daemon, condition.ConditionId, "A|B", 2);
        await WaitForDaemonBaseAvailableSatsAsync(daemon, 0);
    }

    [Fact]
    public async Task CliConsolidate_T3_CompleteHoldingToCollateral()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            registerEngine: false,
            titlePrefix: "WS-P2-H consolidate T3");
        await using var fakeEngine = new FakeMarketServer(
            condition.ConditionId,
            condition.PrimitiveOutcomeSetIds,
            status: "pending");
        var daemon = await StartDaemonAsync();
        await ConfigureDaemonEngineAsync(daemon, fakeEngine.Url);
        var marketId = $"{condition.ConditionId}-{condition.PrimitiveOutcomeSetIds[0]}";

        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "A", amountSats: 2);
        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "B", amountSats: 2);
        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "C", amountSats: 2);

        using var result = await RunCliJsonAsync(daemon, [
            "wallet",
            "consolidate",
            marketId,
        ], TimeSpan.FromSeconds(30));

        AssertConsolidationResult(
            result,
            expectedType: "t3",
            expectedCollateralReturnedSats: 1,
            ("*", 1));
        await WaitForDaemonBaseAvailableSatsAsync(daemon, 1);
        foreach (var primitive in condition.PrimitiveOutcomeSetIds)
        {
            await WaitForDaemonExactOutcomeSatsAsync(daemon, condition.ConditionId, primitive, 0);
        }
    }

    [Fact]
    public async Task Cli_ComplementarySettlement_SurvivesMakerActiveSwapRestart()
    {
        var maker = await StartDaemonAsync();
        var taker = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var makerMarketId = $"{condition.ConditionId}-{condition.NoOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{condition.YesOutcomeSetId}";
        const int faceAmountSubunits = 100;
        const int quoteAmountSats = 50;
        const int makerFundingSats = 210;
        var takerFundingSats = GrossCtfFaceAmountForSpendableSats(quoteAmountSats);

        var makerSatToken = await MintTokenAsync("sats", makerFundingSats);
        using var makerReceive = await RunCliJsonAsync(maker, [
            "wallet",
            "receive",
            makerSatToken,
        ]);
        Assert.True(makerReceive.RootElement.GetProperty("ok").GetBoolean());

        var takerSatToken = await MintTokenAsync("sats", takerFundingSats);
        using var takerReceive = await RunCliJsonAsync(taker, [
            "wallet",
            "receive",
            takerSatToken,
        ]);
        Assert.True(takerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            condition.NoOutcomeSetId,
            "Buy",
            "50",
            faceAmountSubunits.ToString(),
            "GTC",
        ]);
        Assert.True(makerSubmit.RootElement.GetProperty("ok").GetBoolean());

        using var takerSubmit = await RunCliJsonAsync(taker, [
            "order",
            "submit",
            takerMarketId,
            condition.YesOutcomeSetId,
            "Buy",
            "50",
            faceAmountSubunits.ToString(),
            "FAK",
        ]);
        Assert.True(takerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var takerEngine = takerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        var fill = Assert.Single(takerEngine.GetProperty("fills").EnumerateArray());
        var tradeId = fill.GetProperty("tradeId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(tradeId));
        Assert.Equal("Mint", fill.GetProperty("settlementKind").GetString());

        await RestartDaemonAsync(maker);

        await WaitForTradeStepAsync(maker, tradeId!, "confirmed");
        await WaitForTradeStepAsync(taker, tradeId!, "confirmed");
    }

    [Fact]
    public async Task Cli_ComplementarySettlement_SurvivesTakerActiveSwapRestart()
    {
        var maker = await StartDaemonAsync();
        var taker = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var makerMarketId = $"{condition.ConditionId}-{condition.NoOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{condition.YesOutcomeSetId}";
        const int faceAmountSubunits = 100;
        const int quoteAmountSats = 50;
        const int makerFundingSats = 210;
        var takerFundingSats = GrossCtfFaceAmountForSpendableSats(quoteAmountSats);

        var makerSatToken = await MintTokenAsync("sats", makerFundingSats);
        using var makerReceive = await RunCliJsonAsync(maker, [
            "wallet",
            "receive",
            makerSatToken,
        ]);
        Assert.True(makerReceive.RootElement.GetProperty("ok").GetBoolean());

        var takerSatToken = await MintTokenAsync("sats", takerFundingSats);
        using var takerReceive = await RunCliJsonAsync(taker, [
            "wallet",
            "receive",
            takerSatToken,
        ]);
        Assert.True(takerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            condition.NoOutcomeSetId,
            "Buy",
            "50",
            faceAmountSubunits.ToString(),
            "GTC",
        ]);
        Assert.True(makerSubmit.RootElement.GetProperty("ok").GetBoolean());

        using var takerSubmit = await RunCliJsonAsync(taker, [
            "order",
            "submit",
            takerMarketId,
            condition.YesOutcomeSetId,
            "Buy",
            "50",
            faceAmountSubunits.ToString(),
            "FAK",
        ]);
        Assert.True(takerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var takerEngine = takerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        var fill = Assert.Single(takerEngine.GetProperty("fills").EnumerateArray());
        var tradeId = fill.GetProperty("tradeId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(tradeId));
        Assert.Equal("Mint", fill.GetProperty("settlementKind").GetString());

        await RestartDaemonAsync(taker);

        await WaitForTradeStepAsync(maker, tradeId!, "confirmed");
        await WaitForTradeStepAsync(taker, tradeId!, "confirmed");
    }


    [Fact]
    public async Task Cli_DirectSettlement_ReachesConfirmedThroughTwoDaemons()
    {
        var seller = await StartDaemonAsync();
        var buyer = await StartDaemonAsync();
        var condition = await FindFundableOutcomeAsync();
        var marketId = $"{condition.ConditionId}-{condition.OutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            condition.OutcomeSetId);
        using var sellerReceive = await RunCliJsonAsync(seller, [
            "wallet",
            "receive",
            sellerOutcomeToken,
            "--condition-id",
            condition.ConditionId,
            "--outcome-set",
            condition.OutcomeSetId,
        ]);
        Assert.True(sellerReceive.RootElement.GetProperty("ok").GetBoolean());

        var buyerSatToken = await MintTokenAsync("sats", amountSats);
        using var buyerReceive = await RunCliJsonAsync(buyer, [
            "wallet",
            "receive",
            buyerSatToken,
        ]);
        Assert.True(buyerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var sellerSubmit = await RunCliJsonAsync(seller, [
            "order",
            "submit",
            marketId,
            condition.OutcomeSetId,
            "Sell",
            price,
            amountSats.ToString(),
            "GTC",
        ]);
        Assert.True(sellerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var sellerOrderId = sellerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine")
            .GetProperty("orderId")
            .GetString();
        Assert.False(string.IsNullOrWhiteSpace(sellerOrderId));

        using var buyerSubmit = await RunCliJsonAsync(buyer, [
            "order",
            "submit",
            marketId,
            condition.OutcomeSetId,
            "Buy",
            price,
            amountSats.ToString(),
            "FAK",
        ]);
        Assert.True(buyerSubmit.RootElement.GetProperty("ok").GetBoolean());
        var buyerEngine = buyerSubmit.RootElement
            .GetProperty("result")
            .GetProperty("engine");
        var fill = Assert.Single(buyerEngine.GetProperty("fills").EnumerateArray());
        var tradeId = fill.GetProperty("tradeId").GetString();
        Assert.False(string.IsNullOrWhiteSpace(tradeId));

        using var sellerStatus = await RunCliJsonAsync(seller, [
            "order",
            "status",
            marketId,
            sellerOrderId!,
        ]);
        Assert.True(sellerStatus.RootElement.GetProperty("ok").GetBoolean());

        await WaitForTradeStepAsync(seller, tradeId!, "confirmed");
        await WaitForTradeStepAsync(buyer, tradeId!, "confirmed");
    }

    [Fact]
    public async Task BrowserBuyer_CliDaemonSeller_DirectSettlement_ReachesConfirmed()
    {
        var seller = await StartDaemonAsync();
        using var fixtureHttpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateBinaryMarketFixtureAsync(fixtureHttpClient);
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);
        using var sellerReceive = await RunCliJsonAsync(seller, [
            "wallet",
            "receive",
            sellerOutcomeToken,
            "--condition-id",
            condition.ConditionId,
            "--outcome-set",
            tradingOutcomeSetId,
        ]);
        Assert.True(sellerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var sellerSubmit = await RunCliJsonAsync(seller, [
            "order",
            "submit",
            marketId,
            tradingOutcomeSetId,
            "Sell",
            price,
            amountSats.ToString(),
            "GTC",
        ]);
        Assert.True(sellerSubmit.RootElement.GetProperty("ok").GetBoolean());
        await WaitForEngineAskAsync(marketId, amountSats);

        var tradeId = await RunBrowserBuyerDirectFillAsync(
            condition.ConditionId,
            tradingOutcomeSetId,
            marketId,
            amountSats);

        await WaitForTradeStepAsync(seller, tradeId, "confirmed");
    }

    [Fact]
    public async Task BrowserBuyer_CliDaemonSeller_DirectSettlement_SurvivesSellerDaemonRestart()
    {
        var seller = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);
        using var sellerReceive = await RunCliJsonAsync(seller, [
            "wallet",
            "receive",
            sellerOutcomeToken,
            "--condition-id",
            condition.ConditionId,
            "--outcome-set",
            tradingOutcomeSetId,
        ]);
        Assert.True(sellerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var sellerSubmit = await RunCliJsonAsync(seller, [
            "order",
            "submit",
            marketId,
            tradingOutcomeSetId,
            "Sell",
            price,
            amountSats.ToString(),
            "GTC",
        ]);
        Assert.True(sellerSubmit.RootElement.GetProperty("ok").GetBoolean());
        await WaitForEngineAskAsync(marketId, amountSats);

        await RestartDaemonAsync(seller);

        var tradeId = await RunBrowserBuyerDirectFillAsync(
            condition.ConditionId,
            tradingOutcomeSetId,
            marketId,
            amountSats);

        await WaitForTradeStepAsync(seller, tradeId, "confirmed");
    }

    [Fact]
    public async Task BrowserBuyer_CliDaemonSeller_DirectSettlement_SurvivesSellerActiveSwapRestart()
    {
        var seller = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);
        using var sellerReceive = await RunCliJsonAsync(seller, [
            "wallet",
            "receive",
            sellerOutcomeToken,
            "--condition-id",
            condition.ConditionId,
            "--outcome-set",
            tradingOutcomeSetId,
        ]);
        Assert.True(sellerReceive.RootElement.GetProperty("ok").GetBoolean());

        using var sellerSubmit = await RunCliJsonAsync(seller, [
            "order",
            "submit",
            marketId,
            tradingOutcomeSetId,
            "Sell",
            price,
            amountSats.ToString(),
            "GTC",
        ]);
        Assert.True(sellerSubmit.RootElement.GetProperty("ok").GetBoolean());
        await WaitForEngineAskAsync(marketId, amountSats);

        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                var page = await context.NewPageAsync();
                var consoleMessages = TestHelpers.AttachConsoleCapture(page);

                await SetupBrowserWalletAndSignerAsync(page);
                await DepositBrowserSatsAsync(page, amountSats, consoleMessages);
                var tradeId = await SubmitBrowserMarketBuyAsync(
                    page,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    amountSats,
                    consoleMessages);

                await WaitForTradeStepAsync(
                    seller,
                    tradeId,
                    "seller-opened",
                    TimeSpan.FromSeconds(150),
                    // The browser buyer can drive the mock direct-settlement
                    // path from seller-opened to confirmed between daemon
                    // polls. For this restart smoke, any later monotonic step
                    // proves the seller opened before the restart assertion.
                    allowLaterStep: true);

                await RestartDaemonAsync(seller);

                await WaitForTradeStepAsync(
                    seller,
                    tradeId,
                    "confirmed",
                    TimeSpan.FromSeconds(150));
                await WaitForBrowserOutcomeProofsAsync(
                    page,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    consoleMessages);
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserSeller_BrowserBuyer_DirectSettlement_PersistsBothWalletResults()
    {
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const int price = 50;
        var expectedSellerSpendableSats = SpendableCtfSats(amountSats * price / 100);
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);

        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var sellerContext = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                await using var buyerContext = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                await AddSignalRDebugAsync(sellerContext);
                await AddSignalRDebugAsync(buyerContext);

                var sellerPage = await sellerContext.NewPageAsync();
                var buyerPage = await buyerContext.NewPageAsync();
                var sellerConsole = TestHelpers.AttachConsoleCapture(sellerPage);
                var buyerConsole = TestHelpers.AttachConsoleCapture(buyerPage);

                await SetupBrowserWalletAndSignerAsync(
                    sellerPage,
                    "11".PadRight(64, '1'));
                await SeedBrowserOutcomeProofsAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    sellerOutcomeProofs,
                    sellerConsole);
                await SubmitBrowserLimitSellAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    price,
                    amountSats,
                    sellerConsole,
                    requireOrderJoin: true);
                await WaitForEngineAskAsync(marketId, amountSats);
                await sellerPage.BringToFrontAsync();

                await SetupBrowserWalletAndSignerAsync(
                    buyerPage,
                    "22".PadRight(64, '2'));
                await DepositBrowserSatsAsync(buyerPage, amountSats, buyerConsole);
                var tradeId = await SubmitBrowserMarketBuyAsync(
                    buyerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    amountSats,
                    buyerConsole,
                    limitPrice: price);
                Assert.False(string.IsNullOrWhiteSpace(tradeId));

                await WaitForBrowserTradeConfirmedAsync(
                    tradeId,
                    [(sellerPage, sellerConsole), (buyerPage, buyerConsole)]);
                await WaitForBrowserOutcomeProofsAsync(
                    buyerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    buyerConsole);
                await WaitForBrowserBaseProofsAsync(
                    sellerPage,
                    expectedSellerSpendableSats,
                    sellerConsole);
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserSeller_CliDaemonBuyer_DirectSettlement_ReachesConfirmed()
    {
        var buyer = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);

        var buyerSatToken = await MintTokenAsync("sats", amountSats);
        using var buyerReceive = await RunCliJsonAsync(buyer, [
            "wallet",
            "receive",
            buyerSatToken,
        ]);
        Assert.True(buyerReceive.RootElement.GetProperty("ok").GetBoolean());

        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var sellerContext = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                var sellerPage = await sellerContext.NewPageAsync();
                var sellerConsole = TestHelpers.AttachConsoleCapture(sellerPage);

                await SetupBrowserWalletAndSignerAsync(
                    sellerPage,
                    "33".PadRight(64, '3'));
                await SeedBrowserOutcomeProofsAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    sellerOutcomeProofs,
                    sellerConsole);
                await SubmitBrowserLimitSellAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    price,
                    amountSats,
                    sellerConsole);
                await WaitForEngineAskAsync(marketId, amountSats);

                using var buyerSubmit = await RunCliJsonAsync(buyer, [
                    "order",
                    "submit",
                    marketId,
                    tradingOutcomeSetId,
                    "Buy",
                    price.ToString(),
                    amountSats.ToString(),
                    "FAK",
                ]);
                Assert.True(buyerSubmit.RootElement.GetProperty("ok").GetBoolean());
                var buyerEngine = buyerSubmit.RootElement
                    .GetProperty("result")
                    .GetProperty("engine");
                var fill = Assert.Single(buyerEngine.GetProperty("fills").EnumerateArray());
                var tradeId = fill.GetProperty("tradeId").GetString();
                Assert.False(string.IsNullOrWhiteSpace(tradeId));

                await WaitForTradeStepAsync(buyer, tradeId!, "confirmed");
                await WaitForBrowserBaseProofsAsync(
                    sellerPage,
                    SpendableCtfSats(amountSats * price / 100),
                    sellerConsole);
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserSeller_CliDaemonBuyer_DirectSettlement_SurvivesBuyerDaemonRestart()
    {
        var buyer = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);

        var buyerSatToken = await MintTokenAsync("sats", amountSats);
        using var buyerReceive = await RunCliJsonAsync(buyer, [
            "wallet",
            "receive",
            buyerSatToken,
        ]);
        Assert.True(buyerReceive.RootElement.GetProperty("ok").GetBoolean());

        await RestartDaemonAsync(buyer);

        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var sellerContext = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                var sellerPage = await sellerContext.NewPageAsync();
                var sellerConsole = TestHelpers.AttachConsoleCapture(sellerPage);

                await SetupBrowserWalletAndSignerAsync(
                    sellerPage,
                    "44".PadRight(64, '4'));
                await SeedBrowserOutcomeProofsAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    sellerOutcomeProofs,
                    sellerConsole);
                await SubmitBrowserLimitSellAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    price,
                    amountSats,
                    sellerConsole);
                await WaitForEngineAskAsync(marketId, amountSats);

                using var buyerSubmit = await RunCliJsonAsync(buyer, [
                    "order",
                    "submit",
                    marketId,
                    tradingOutcomeSetId,
                    "Buy",
                    price.ToString(),
                    amountSats.ToString(),
                    "FAK",
                ]);
                Assert.True(buyerSubmit.RootElement.GetProperty("ok").GetBoolean());
                var buyerEngine = buyerSubmit.RootElement
                    .GetProperty("result")
                    .GetProperty("engine");
                var fill = Assert.Single(buyerEngine.GetProperty("fills").EnumerateArray());
                var tradeId = fill.GetProperty("tradeId").GetString();
                Assert.False(string.IsNullOrWhiteSpace(tradeId));

                await WaitForTradeStepAsync(buyer, tradeId!, "confirmed");
                await WaitForBrowserBaseProofsAsync(
                    sellerPage,
                    SpendableCtfSats(amountSats * price / 100),
                    sellerConsole);
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    [Fact]
    public async Task BrowserSeller_CliDaemonBuyer_DirectSettlement_SurvivesBuyerActiveSwapRestart()
    {
        var buyer = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        var sellerOutcomeFaceAmountSubunits = GrossCtfFaceAmountForSpendableSats(amountSats);
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            sellerOutcomeFaceAmountSubunits,
            condition.ConditionId,
            tradingOutcomeSetId);

        var buyerSatToken = await MintTokenAsync("sats", amountSats);
        using var buyerReceive = await RunCliJsonAsync(buyer, [
            "wallet",
            "receive",
            buyerSatToken,
        ]);
        Assert.True(buyerReceive.RootElement.GetProperty("ok").GetBoolean());

        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var sellerContext = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                var sellerPage = await sellerContext.NewPageAsync();
                var sellerConsole = TestHelpers.AttachConsoleCapture(sellerPage);

                await SetupBrowserWalletAndSignerAsync(
                    sellerPage,
                    "55".PadRight(64, '5'));
                await SeedBrowserOutcomeProofsAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    sellerOutcomeProofs,
                    sellerConsole);
                await SubmitBrowserLimitSellAsync(
                    sellerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    marketId,
                    price,
                    amountSats,
                    sellerConsole);
                await WaitForEngineAskAsync(marketId, amountSats);

                using var buyerSubmit = await RunCliJsonAsync(buyer, [
                    "order",
                    "submit",
                    marketId,
                    tradingOutcomeSetId,
                    "Buy",
                    price.ToString(),
                    amountSats.ToString(),
                    "FAK",
                ]);
                Assert.True(buyerSubmit.RootElement.GetProperty("ok").GetBoolean());
                var buyerEngine = buyerSubmit.RootElement
                    .GetProperty("result")
                    .GetProperty("engine");
                var fill = Assert.Single(buyerEngine.GetProperty("fills").EnumerateArray());
                var tradeId = fill.GetProperty("tradeId").GetString();
                Assert.False(string.IsNullOrWhiteSpace(tradeId));

                await RestartDaemonAsync(buyer);

                await WaitForTradeStepAsync(buyer, tradeId!, "confirmed");
                await WaitForBrowserBaseProofsAsync(
                    sellerPage,
                    SpendableCtfSats(amountSats * price / 100),
                    sellerConsole);
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    private async Task<ITradingClient> CreateTradingClientAsync(
        TradingClientKind kind,
        IBrowser? browser,
        string browserNsec)
    {
        if (kind == TradingClientKind.Cli)
            return new CliTradingClient(this, await StartDaemonAsync());

        if (browser is null)
            throw new InvalidOperationException("GUI trading client requires a Playwright browser.");

        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ServiceWorkers = ServiceWorkerPolicy.Block,
        });
        await AddSignalRDebugAsync(context);
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupBrowserWalletAndSignerAsync(page, browserNsec);
        return new GuiTradingClient(page, consoleMessages);
    }

    private static Task AddSignalRDebugAsync(IBrowserContext context)
    {
        return context.AddInitScriptAsync("""
            (() => {
              const originalSend = WebSocket.prototype.send;
              const originalAddEventListener = WebSocket.prototype.addEventListener;
              WebSocket.prototype.send = function(data) {
                try {
                  const text = typeof data === 'string' ? data : '';
                  if (text.includes('"target":"JoinOrder"')) {
                    console.debug(`[e2e-signalr-send] JoinOrder ${text}`);
                  }
                  if (text.includes('"target":"JoinTrade"')) {
                    console.debug(`[e2e-signalr-send] JoinTrade ${text}`);
                  }
                } catch {
                  // Test instrumentation must never alter app behavior.
                }
                return originalSend.apply(this, arguments);
              };
              WebSocket.prototype.addEventListener = function(type, listener, options) {
                if (type === 'message' && typeof listener === 'function') {
                  const wrapped = function(event) {
                    try {
                      const text = typeof event.data === 'string' ? event.data : '';
                      if (text.includes('TradeCreated') || text.includes('TradeStateChanged') || text.includes('"error"') || text.includes('"type":3')) {
                        console.debug(`[e2e-signalr-recv] ${text}`);
                      }
                    } catch {
                      // Test instrumentation must never alter app behavior.
                    }
                    return listener.apply(this, arguments);
                  };
                  return originalAddEventListener.call(this, type, wrapped, options);
                }
                return originalAddEventListener.call(this, type, listener, options);
              };
            })();
            """);
    }

    private interface ITradingClient
    {
        Task FundSatsAsync(int amountSats);

        Task<string> SubmitRestingComplementaryMakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats,
            bool preflightSplit,
            string? displayedOutcomeSetId = null);

        Task<string> SubmitComplementaryTakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats);

        Task WaitConfirmedAsync(string tradeId);

        Task RefreshMatchedOrderAsync(string marketId, string orderId, string tradeId);

        Task<Exception> BuildDiagnosticExceptionAsync(string context);

        Task AssertAvailableOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumAvailableSats);

        Task AssertReservedOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumReservedSats);
    }

    private sealed class CliTradingClient(
        CliDaemonE2ETests owner,
        DaemonHandle daemon) : ITradingClient
    {
        public async Task FundSatsAsync(int amountSats)
        {
            var token = await owner.MintTokenAsync("sats", amountSats);
            using var receive = await owner.RunCliJsonAsync(daemon, [
                "wallet",
                "receive",
                token,
            ]);
            Assert.True(receive.RootElement.GetProperty("ok").GetBoolean());
        }

        public async Task<string> SubmitRestingComplementaryMakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats,
            bool preflightSplit,
            string? displayedOutcomeSetId = null)
        {
            var requestOutcomeSetId = displayedOutcomeSetId ?? outcomeSetId;
            var args = new List<string>
            {
                "order",
                "submit",
                marketId,
                requestOutcomeSetId,
                "Buy",
                price.ToString(),
                amountSats.ToString(),
                "GTC",
            };
            if (displayedOutcomeSetId is not null)
            {
                args.Add("--token-side");
                args.Add("Complement");
            }
            if (!preflightSplit)
            {
                args.Add("--no-preflight-split");
            }

            using var submit = await owner.RunCliJsonAsync(daemon, args.ToArray());
            Assert.True(submit.RootElement.GetProperty("ok").GetBoolean());
            var orderId = submit.RootElement
                .GetProperty("result")
                .GetProperty("engine")
                .GetProperty("orderId")
                .GetString();
            Assert.False(string.IsNullOrWhiteSpace(orderId));
            return orderId!;
        }

        public async Task<string> SubmitComplementaryTakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats)
        {
            using var submit = await owner.RunCliJsonAsync(daemon, [
                "order",
                "submit",
                marketId,
                outcomeSetId,
                "Buy",
                price.ToString(),
                amountSats.ToString(),
                "FAK",
            ]);
            var submitBody = submit.RootElement.GetRawText();
            Assert.True(
                submit.RootElement.TryGetProperty("ok", out var ok)
                && ok.ValueKind == JsonValueKind.True,
                $"CLI taker order submit failed or returned an unexpected shape. Body={submitBody}");
            Assert.True(
                submit.RootElement.TryGetProperty("result", out var result),
                $"CLI taker order submit did not include result. Body={submitBody}");
            Assert.True(
                result.TryGetProperty("engine", out var engine),
                $"CLI taker order submit did not include result.engine. Body={submitBody}");
            Assert.True(
                engine.TryGetProperty("fills", out var fills)
                && fills.ValueKind == JsonValueKind.Array,
                $"CLI taker order submit did not include engine.fills. Body={submitBody}");
            var fill = Assert.Single(fills.EnumerateArray());
            Assert.True(
                fill.TryGetProperty("tradeId", out var tradeIdElement)
                && tradeIdElement.ValueKind == JsonValueKind.String,
                $"CLI taker fill did not include tradeId. Body={submitBody}");
            var tradeId = tradeIdElement.GetString();
            Assert.False(string.IsNullOrWhiteSpace(tradeId));
            var settlementKind = fill.TryGetProperty("settlementKind", out var settlementKindElement)
                ? settlementKindElement.GetString()
                : fill.TryGetProperty("path", out var pathElement)
                    ? pathElement.GetString()
                    : null;
            Assert.Equal("Mint", settlementKind, ignoreCase: true);
            return tradeId!;
        }

        public Task WaitConfirmedAsync(string tradeId) =>
            owner.WaitForTradeStepAsync(daemon, tradeId, "confirmed");

        public async Task RefreshMatchedOrderAsync(string marketId, string orderId, string tradeId)
        {
            var deadline = DateTime.UtcNow.AddSeconds(30);
            JsonElement? lastLocal = null;
            while (DateTime.UtcNow < deadline)
            {
                using var status = await owner.RunCliJsonAsync(daemon, [
                    "order",
                    "status",
                    marketId,
                    orderId,
                ]);
                Assert.True(status.RootElement.GetProperty("ok").GetBoolean());

                var local = status.RootElement.GetProperty("result").GetProperty("local");
                lastLocal = local.Clone();
                if (local.TryGetProperty("tradeIds", out var tradeIds)
                    && tradeIds.ValueKind == JsonValueKind.Array
                    && tradeIds.EnumerateArray().Any(id =>
                        string.Equals(id.GetString(), tradeId, StringComparison.OrdinalIgnoreCase)))
                {
                    break;
                }

                await Task.Delay(500);
            }

            var foundTrade = lastLocal.HasValue
                && lastLocal.Value.TryGetProperty("tradeIds", out var finalTradeIds)
                && finalTradeIds.ValueKind == JsonValueKind.Array
                && finalTradeIds.EnumerateArray().Any(id =>
                    string.Equals(id.GetString(), tradeId, StringComparison.OrdinalIgnoreCase));
            Assert.True(
                foundTrade,
                $"Maker order status did not include trade {tradeId}. Last local order: {lastLocal?.GetRawText() ?? "(none)"}");

            using var recover = await owner.RunCliJsonAsync(daemon, [
                "trade",
                "recover",
            ]);
            Assert.True(recover.RootElement.GetProperty("ok").GetBoolean());
        }

        public Task<Exception> BuildDiagnosticExceptionAsync(string context) =>
            Task.FromResult<Exception>(new TimeoutException(context));

        public Task AssertAvailableOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumAvailableSats) =>
            owner.WaitForDaemonOutcomeProofsAsync(
                daemon,
                conditionId,
                outcomeSetId,
                minimumAvailableSats,
                reserved: false);

        public Task AssertReservedOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumReservedSats) =>
            owner.WaitForDaemonOutcomeProofsAsync(
                daemon,
                conditionId,
                outcomeSetId,
                minimumReservedSats,
                reserved: true);
    }

    private sealed class GuiTradingClient(
        IPage page,
        IReadOnlyList<string> consoleMessages) : ITradingClient
    {
        public Task FundSatsAsync(int amountSats) =>
            DepositBrowserSatsAsync(page, amountSats, consoleMessages);

        public Task<string> SubmitRestingComplementaryMakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats,
            bool preflightSplit,
            string? displayedOutcomeSetId = null) =>
            SubmitBrowserLimitBuyRestingAsync(
                page,
                conditionId,
                outcomeSetId,
                marketId,
                price,
                amountSats,
                preflightSplit,
                consoleMessages,
                displayedOutcomeSetId);

        public Task<string> SubmitComplementaryTakerBuyAsync(
            string conditionId,
            string outcomeSetId,
            string marketId,
            int price,
            int amountSats) =>
            SubmitBrowserMarketBuyAsync(
                page,
                conditionId,
                outcomeSetId,
                marketId,
                amountSats,
                consoleMessages,
                limitPrice: price);

        public Task WaitConfirmedAsync(string tradeId) =>
            WaitForBrowserTradeConfirmedAsync(tradeId, [(page, consoleMessages)]);

        public Task RefreshMatchedOrderAsync(string marketId, string orderId, string tradeId) => Task.CompletedTask;

        public Task<Exception> BuildDiagnosticExceptionAsync(string context) =>
            TestHelpers.BuildDiagnosticExceptionAsync(page, consoleMessages, context);

        public Task AssertAvailableOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumAvailableSats) =>
            WaitForBrowserOutcomeProofsAsync(
                page,
                conditionId,
                outcomeSetId,
                consoleMessages,
                minimumSats: minimumAvailableSats,
                availableOnly: true);

        public Task AssertReservedOutcomeProofsAsync(
            string conditionId,
            string outcomeSetId,
            int minimumReservedSats) =>
            WaitForBrowserOutcomeProofsAsync(
                page,
                conditionId,
                outcomeSetId,
                consoleMessages,
                minimumSats: minimumReservedSats,
                reservedOnly: true);
    }

    public async Task DisposeAsync()
    {
        foreach (var daemon in _daemons)
        {
            if (daemon.Process is { HasExited: false })
            {
                daemon.Process.Kill(entireProcessTree: true);
                await daemon.Process.WaitForExitAsync();
            }
            daemon.Process?.Dispose();
            try
            {
                Directory.Delete(daemon.Home, recursive: true);
            }
            catch
            {
                // Best-effort cleanup only; failed test diagnostics are more useful
                // than masking the original assertion with a temp-dir delete error.
            }
        }
    }

    private string BitcasterDaemonMain =>
        Path.Combine(_repoRoot, "bitcaster-daemon", "src", "main.ts");

    private string BitcasterCliMain =>
        Path.Combine(_repoRoot, "bitcaster-cli", "src", "main.ts");

    private string MintDaemonTokenScript =>
        Path.Combine(_repoRoot, "bitcaster-daemon", "scripts", "mint-token.ts");

    private string RegisterConditionScript =>
        Path.Combine(_repoRoot, "bitcaster-daemon", "scripts", "register-condition.ts");

    private async Task<DaemonHandle> StartDaemonAsync()
    {
        var daemon = new DaemonHandle(
            Path.Combine(Path.GetTempPath(), $"bitcaster-daemon-e2e-{Guid.NewGuid():N}"),
            ReserveTcpPort());
        Directory.CreateDirectory(daemon.Home);
        await RunNodeAsync(BitcasterDaemonMain, ["init"], daemon);
        daemon.Process = StartNode(BitcasterDaemonMain, ["run"], daemon);
        _daemons.Add(daemon);
        await WaitForDaemonHealthAsync(daemon);
        return daemon;
    }

    private async Task RestartDaemonAsync(DaemonHandle daemon)
    {
        if (daemon.Process is { HasExited: false })
        {
            daemon.Process.Kill(entireProcessTree: true);
            await daemon.Process.WaitForExitAsync();
        }
        daemon.Process?.Dispose();
        daemon.Process = StartNode(BitcasterDaemonMain, ["run"], daemon);
        await WaitForDaemonHealthAsync(daemon);
    }

    private async Task WaitForDaemonHealthAsync(DaemonHandle daemon)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        Exception? last = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var health = await RunCliJsonAsync(daemon, ["health"], timeout: TimeSpan.FromSeconds(3));
                if (health.RootElement.GetProperty("ok").GetBoolean())
                    return;
            }
            catch (Exception ex)
            {
                last = ex;
            }
            await Task.Delay(250);
        }

        throw new TimeoutException(
            $"bitcaster-daemon did not become healthy on port {daemon.Port}. " +
            $"Last error: {last?.Message ?? "(none)"}");
    }

    private async Task<JsonDocument> RunCliJsonAsync(
        DaemonHandle daemon,
        string[] args,
        TimeSpan? timeout = null)
    {
        var result = await RunNodeAsync(BitcasterCliMain, args, daemon, timeout);
        return JsonDocument.Parse(result.Stdout);
    }

    private Task<ProcessResult> RunCliProcessAsync(
        DaemonHandle daemon,
        string[] args,
        TimeSpan? timeout = null) =>
        RunNodeProcessAsync(BitcasterCliMain, args, daemon, timeout);

    private async Task ConfigureDaemonEngineAsync(DaemonHandle daemon, string engineUrl)
    {
        using var config = await RunCliJsonAsync(daemon, [
            "daemon",
            "config",
            "--engine-url",
            engineUrl,
        ], TimeSpan.FromSeconds(5));
        Assert.True(config.RootElement.GetProperty("ok").GetBoolean());
        await RestartDaemonAsync(daemon);
    }

    private async Task WaitForTradeStepAsync(
        DaemonHandle daemon,
        string tradeId,
        string expectedStep,
        TimeSpan? timeout = null,
        bool allowLaterStep = false)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(60));
        string? lastStep = null;
        string? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            using var trade = await RunCliJsonAsync(daemon, ["trade", "watch", tradeId], TimeSpan.FromSeconds(5));
            if (trade.RootElement.GetProperty("ok").GetBoolean())
            {
                var result = trade.RootElement.GetProperty("result");
                if (result.ValueKind == JsonValueKind.Object)
                {
                    lastStep = result.GetProperty("step").GetString();
                    if (result.TryGetProperty("error", out var err)
                        && err.ValueKind == JsonValueKind.String)
                    {
                        lastError = err.GetString();
                    }
                    if (string.Equals(lastStep, expectedStep, StringComparison.OrdinalIgnoreCase))
                        return;
                    if (allowLaterStep && HasReachedOrPassedNonTerminalTradeStep(lastStep, expectedStep))
                        return;
                    if (string.Equals(lastStep, "failed", StringComparison.OrdinalIgnoreCase))
                        break;
                }
            }
            await Task.Delay(allowLaterStep ? 100 : 500);
        }

        throw new TimeoutException(
            $"Trade {tradeId} did not reach {expectedStep}. " +
            $"Last step={lastStep ?? "(none)"}, error={lastError ?? "(none)"}");
    }

    private static bool HasReachedOrPassedNonTerminalTradeStep(string? actualStep, string expectedStep)
    {
        if (string.IsNullOrWhiteSpace(actualStep)) return false;
        var expectedIndex = TradeStepProgressionIndex(expectedStep);
        var actualIndex = TradeStepProgressionIndex(actualStep);
        return expectedIndex >= 0 && actualIndex >= expectedIndex && actualIndex < 6;
    }

    private static int TradeStepProgressionIndex(string step) =>
        step.ToLowerInvariant() switch
        {
            "awaiting-trade-created" => 0,
            "opened" => 1,
            "seller-opened" => 2,
            "buyer-responded" => 3,
            "settling" => 4,
            "awaiting-confirmation" => 5,
            "confirmed" => 6,
            "refunded" => 6,
            _ => -1,
        };

    private async Task<string> RunBrowserBuyerDirectFillAsync(
        string conditionId,
        string outcomeSetId,
        string marketId,
        int amountSats)
    {
        var playwright = await Playwright.CreateAsync();
        try
        {
            var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
            {
                Headless = true,
            });
            try
            {
                await using var context = await browser.NewContextAsync(new BrowserNewContextOptions
                {
                    ServiceWorkers = ServiceWorkerPolicy.Block,
                });
                var page = await context.NewPageAsync();
                var consoleMessages = TestHelpers.AttachConsoleCapture(page);

                await SetupBrowserWalletAndSignerAsync(page);
                await DepositBrowserSatsAsync(page, amountSats, consoleMessages);
                var tradeId = await SubmitBrowserMarketBuyAsync(
                    page,
                    conditionId,
                    outcomeSetId,
                    marketId,
                    amountSats,
                    consoleMessages);
                await WaitForBrowserTradeConfirmedAsync(
                    tradeId,
                    [(page, consoleMessages)]);
                await WaitForBrowserOutcomeProofsAsync(
                    page,
                    conditionId,
                    outcomeSetId,
                    consoleMessages);
                return tradeId;
            }
            finally
            {
                await browser.CloseAsync();
            }
        }
        finally
        {
            playwright.Dispose();
        }
    }

    private static async Task SetupBrowserWalletAndSignerAsync(
        IPage page,
        string nsec = "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5")
    {
        var mnemonic = TestMnemonics.Get();
        await page.GotoAsync($"{TestPorts.FrontendUrl}/setup", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.DOMContentLoaded,
            Timeout = 30_000,
        });
        await page.EvaluateAsync($@"
            localStorage.setItem('bitcaster-wallet', JSON.stringify({{
                state: {{
                    mnemonic: '{mnemonic}',
                    setupComplete: true,
                    walletBackupState: 'confirmed',
                    mints: [{{ url: '{TestPorts.MintUrl}', info: {{ name: 'Test Mint', nuts: {{}} }} }}],
                    activeMintUrl: '{TestPorts.MintUrl}',
                    keysetCounters: {{}},
                    mintConnectionStatuses: {{}}
                }},
                version: 0
            }}));
            localStorage.setItem('bitcaster-settings', JSON.stringify({{
                state: {{
                    activeCategory: 'general',
                    baseCurrency: 'BTC',
                    language: 'en',
                    theme: 'dark',
                    nostrSignerMode: 'nsec',
                    signerBackupState: 'confirmed',
                    nsecSecret: '{nsec}',
                    nostrProfile: null,
                    nostrProfileFetchStatus: 'idle',
                    relays: []
                }},
                version: 0
            }}));
        ");
    }

    private static async Task DepositBrowserSatsAsync(
        IPage page,
        int amountSats,
        IReadOnlyList<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var depositBtn = page.GetByRole(AriaRole.Button, new() { Name = "Deposit" });
        await Assertions.Expect(depositBtn).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await depositBtn.ClickAsync();

        var lightningOption = page.GetByText("Lightning");
        await Assertions.Expect(lightningOption).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await lightningOption.ClickAsync();

        var digits = amountSats.ToString();
        foreach (var digit in digits)
        {
            var digitButton = page.GetByRole(
                AriaRole.Button,
                new() { Name = digit.ToString(), Exact = true });
            await Assertions.Expect(digitButton).ToBeVisibleAsync(new() { Timeout = 5_000 });
            await digitButton.ClickAsync();
        }

        var createBtn = page.GetByRole(AriaRole.Button, new() { Name = "Create Invoice" });
        await Assertions.Expect(createBtn).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await createBtn.ClickAsync();

        await TestHelpers.WaitForBalanceTextAsync(
            page,
            amountSats,
            consoleMessages,
            $"Browser deposit of {amountSats} sats did not credit before mixed settlement.");
        await WaitForBrowserBaseProofsAsync(page, amountSats, consoleMessages);
    }

    private static async Task<string> SubmitBrowserMarketBuyAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        string marketId,
        int amountSats,
        IReadOnlyList<string> consoleMessages,
        int limitPrice = 99)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await EnsureMarketDetailOpenAsync(page, conditionId, consoleMessages);

        var limitOrder = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = TradeOutcomeButton(page, outcomeSetId);
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = TradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await FillNumberInputAsync(amountInput, ToDisplayShares(amountSats));

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        await Assertions.Expect(priceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await priceInput.FillAsync(limitPrice.ToString());

        var preflightSplit = page.Locator("input[type='checkbox']")
            .Filter(new() { Visible = true })
            .First;
        if (await preflightSplit.CountAsync() > 0 && await preflightSplit.IsCheckedAsync())
        {
            await preflightSplit.SetCheckedAsync(false);
            await Assertions.Expect(preflightSplit).Not.ToBeCheckedAsync(new() { Timeout = 5_000 });
        }

        var confirm = TradeConfirmButton(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        var orderResponseTask = page.WaitForResponseAsync(response =>
            response.Request.Method == "POST"
            && response.Url.Contains("/orders", StringComparison.Ordinal));
        await confirm.ClickAsync();
        IResponse orderResponse;
        try
        {
            orderResponse = await orderResponseTask;
        }
        catch
        {
            var status = await VisibleTradingPanel(page).GetByTestId("trade-submit-status")
                .First
                .TextContentAsync(new() { Timeout = 1_000 })
                .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser buyer did not POST an order. status={status ?? "(none)"}, expected marketId={marketId}");
        }
        var orderBody = await orderResponse.TextAsync();

        using var doc = JsonDocument.Parse(orderBody);
        if (!doc.RootElement.TryGetProperty("fills", out var fills))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser order response did not include fills. Body={orderBody}");
        }
        var fillArray = fills.EnumerateArray().ToArray();
        if (fillArray.Length != 1)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser buyer order did not fill against daemon seller liquidity. Body={orderBody}");
        }
        var fill = fillArray[0];
        var tradeId = fill.GetProperty("tradeId").GetString();
        if (string.IsNullOrWhiteSpace(tradeId))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser order fill did not include a tradeId. Body={orderBody}");
        }
        return tradeId;
    }

    private static async Task<string> SubmitBrowserMarketBuyNoAsync(
        IPage page,
        string conditionId,
        string displayedOutcomeSetId,
        string marketId,
        int amountSats,
        IReadOnlyList<string> consoleMessages,
        int limitPrice)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await EnsureMarketDetailOpenAsync(page, conditionId, consoleMessages);

        var marketOrder = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Market", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(marketOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await marketOrder.ClickAsync();

        await ClickBuyNoAsync(page, displayedOutcomeSetId);

        var amountInput = TradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await FillNumberInputAsync(amountInput, ToDisplayShares(amountSats));

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        if (await priceInput.CountAsync() > 0)
        {
            await priceInput.FillAsync(limitPrice.ToString());
        }

        var confirm = TradeConfirmButton(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        var orderResponseTask = page.WaitForResponseAsync(response =>
            response.Request.Method == "POST"
            && response.Url.Contains("/orders", StringComparison.Ordinal));
        await confirm.ClickAsync();

        IResponse orderResponse;
        try
        {
            orderResponse = await orderResponseTask;
        }
        catch
        {
            var status = await VisibleTradingPanel(page).GetByTestId("trade-submit-status")
                .First
                .TextContentAsync(new() { Timeout = 1_000 })
                .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser Buy No did not POST an order. status={status ?? "(none)"}, expected marketId={marketId}");
        }

        var orderBody = await orderResponse.TextAsync();
        if (!orderResponse.Ok)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser Buy No order POST failed with HTTP {orderResponse.Status}. Body={orderBody}");
        }

        using var doc = JsonDocument.Parse(orderBody);
        var fills = doc.RootElement.GetProperty("fills").EnumerateArray().ToArray();
        if (fills.Length != 1)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser Buy No order did not create one mint fill. Body={orderBody}");
        }
        var tradeId = fills[0].GetProperty("tradeId").GetString();
        if (string.IsNullOrWhiteSpace(tradeId))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser Buy No fill did not include a tradeId. Body={orderBody}");
        }
        return tradeId!;
    }

    private static async Task SeedBrowserOutcomeProofsAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        string proofsJson,
        IReadOnlyList<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/portfolio", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var conditionJson = JsonSerializer.Serialize(conditionId);
        var outcomeJson = JsonSerializer.Serialize(outcomeSetId);
        var marketJson = JsonSerializer.Serialize($"{conditionId}-{outcomeSetId}");
        var mintJson = JsonSerializer.Serialize(TestPorts.MintUrl);
        var inserted = await page.EvaluateAsync<int>($$"""
            async () => {
                const proofs = {{proofsJson}};
                const conditionId = {{conditionJson}};
                const outcomeSetId = {{outcomeJson}};
                const marketId = {{marketJson}};
                const mintUrl = {{mintJson}};
                const openWithPoll = async () => {
                    const deadline = Date.now() + 10_000;
                    while (Date.now() < deadline) {
                        const req = indexedDB.open('bitcaster');
                        const db = await new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => reject(req.error);
                            req.onupgradeneeded = () => {};
                        });
                        if (db.objectStoreNames.contains('proofs')) return db;
                        db.close();
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    throw new Error('Dexie did not materialize proofs store within 10s');
                };
                const db = await openWithPoll();
                try {
                    const tx = db.transaction('proofs', 'readwrite');
                    const store = tx.objectStore('proofs');
                    for (const proof of proofs) {
                        store.put({
                            ...proof,
                            mintUrl,
                            conditionId,
                            outcomeCollection: outcomeSetId,
                            marketId,
                            receivedAt: Date.now(),
                        });
                    }
                    await new Promise((resolve, reject) => {
                        tx.oncomplete = () => resolve();
                        tx.onerror = () => reject(tx.error);
                    });
                    const readTx = db.transaction('proofs', 'readonly');
                    const stored = await new Promise((resolve, reject) => {
                        const r = readTx.objectStore('proofs').getAll();
                        r.onsuccess = () => resolve(r.result);
                        r.onerror = () => reject(r.error);
                    });
                    return stored.filter((p) => p.marketId === marketId)
                        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
                } finally {
                    db.close();
                }
            }
            """);
        if (inserted <= 0)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller outcome proofs were not seeded for {conditionId}-{outcomeSetId}.");
        }
    }

    private static async Task SubmitBrowserLimitSellAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        string marketId,
        int limitPrice,
        int amountSats,
        IReadOnlyList<string> consoleMessages,
        bool requireOrderJoin = false)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await EnsureMarketDetailOpenAsync(page, conditionId, consoleMessages);

        var sellToggle = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Sell", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(sellToggle).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await sellToggle.ClickAsync();

        var limitOrder = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = TradeOutcomeButton(page, outcomeSetId);
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = TradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await FillNumberInputAsync(amountInput, ToDisplayShares(amountSats));

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        await Assertions.Expect(priceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await priceInput.FillAsync(limitPrice.ToString());

        var confirm = TradeConfirmButton(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        var orderResponseTask = page.WaitForResponseAsync(response =>
            response.Request.Method == "POST"
            && response.Url.Contains("/orders", StringComparison.Ordinal));
        await confirm.ClickAsync();

        IResponse orderResponse;
        try
        {
            orderResponse = await orderResponseTask;
        }
        catch
        {
            var status = await VisibleTradingPanel(page).GetByTestId("trade-submit-status")
                .First
                .TextContentAsync(new() { Timeout = 1_000 })
                .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller did not POST an order. status={status ?? "(none)"}, expected marketId={marketId}");
        }

        var orderBody = await orderResponse.TextAsync();
        if (!orderResponse.Ok)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller order POST failed with HTTP {orderResponse.Status}. Body={orderBody}");
        }

        using var doc = JsonDocument.Parse(orderBody);
        var statusText = doc.RootElement.GetProperty("status").GetString();
        var fills = doc.RootElement.GetProperty("fills").EnumerateArray().ToArray();
        if (statusText != "resting" || fills.Length != 0)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller order should rest before buyer arrives. Body={orderBody}");
        }
        var orderId = doc.RootElement.GetProperty("orderId").GetString();
        if (string.IsNullOrWhiteSpace(orderId))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller order response did not include orderId. Body={orderBody}");
        }

        var joined = await TryWaitForSignalRInvocationAsync(
            consoleMessages,
            "JoinOrder",
            orderId!,
            timeout: requireOrderJoin ? TimeSpan.FromSeconds(30) : TimeSpan.FromSeconds(5));
        if (requireOrderJoin && !joined)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser seller did not join order group for {orderId} before taker fill.");
        }
    }

    private static async Task<string> SubmitBrowserLimitBuyRestingAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        string marketId,
        int limitPrice,
        int amountSats,
        bool preflight,
        IReadOnlyList<string> consoleMessages,
        string? displayedOutcomeSetId = null)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await EnsureMarketDetailOpenAsync(page, conditionId, consoleMessages);

        var limitOrder = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = TradeOutcomeButton(
            page,
            displayedOutcomeSetId ?? outcomeSetId,
            complement: displayedOutcomeSetId is not null);
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = TradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await FillNumberInputAsync(amountInput, ToDisplayShares(amountSats));

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        await Assertions.Expect(priceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await priceInput.FillAsync(limitPrice.ToString());

        var preflightSplit = page.GetByRole(AriaRole.Checkbox, new() { Name = "Pre-flight split" })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(preflightSplit).ToBeCheckedAsync(new() { Timeout = 5_000 });
        if (!preflight)
        {
            await preflightSplit.ClickAsync();
            await Assertions.Expect(preflightSplit).Not.ToBeCheckedAsync(new() { Timeout = 5_000 });
        }

        var confirm = TradeConfirmButton(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        var orderResponseTask = page.WaitForResponseAsync(response =>
            response.Request.Method == "POST"
            && response.Url.Contains("/orders", StringComparison.Ordinal));
        await confirm.ClickAsync();

        IResponse orderResponse;
        try
        {
            orderResponse = await orderResponseTask;
        }
        catch
        {
            var status = await VisibleTradingPanel(page).GetByTestId("trade-submit-status")
                .First
                .TextContentAsync(new() { Timeout = 1_000 })
                .ContinueWith(t => t.IsCompletedSuccessfully ? t.Result : null);
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser maker did not POST a limit buy. status={status ?? "(none)"}, expected marketId={marketId}");
        }

        var orderBody = await orderResponse.TextAsync();
        if (!orderResponse.Ok)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser maker buy POST failed with HTTP {orderResponse.Status}. Body={orderBody}");
        }

        using var doc = JsonDocument.Parse(orderBody);
        var statusText = doc.RootElement.GetProperty("status").GetString();
        var fills = doc.RootElement.GetProperty("fills").EnumerateArray().ToArray();
        if (statusText != "resting" || fills.Length != 0)
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser maker buy should rest before mint taker arrives. Body={orderBody}");
        }

        var orderId = doc.RootElement.GetProperty("orderId").GetString();
        if (string.IsNullOrWhiteSpace(orderId))
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Browser maker buy response did not include orderId. Body={orderBody}");
        }

        await TryWaitForSignalRInvocationAsync(consoleMessages, "JoinOrder", orderId!);
        return orderId!;
    }

    private static async Task SubmitBrowserLimitBuyExpectTopUpModalAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        int limitPrice,
        int amountSats,
        IReadOnlyList<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });
        await EnsureMarketDetailOpenAsync(page, conditionId, consoleMessages);

        var limitOrder = VisibleTradingPanel(page)
            .GetByRole(AriaRole.Button, new() { Name = "Limit", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = TradeOutcomeButton(page, outcomeSetId);
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = TradeAmountInput(page);
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await FillNumberInputAsync(amountInput, ToDisplayShares(amountSats));

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        await Assertions.Expect(priceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await priceInput.FillAsync(limitPrice.ToString(CultureInfo.InvariantCulture));

        var preflightSplit = page.GetByRole(AriaRole.Checkbox, new() { Name = "Pre-flight split" })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(preflightSplit).ToBeCheckedAsync(new() { Timeout = 5_000 });

        var confirm = TradeConfirmButton(page);
        await Assertions.Expect(confirm).ToBeEnabledAsync(new() { Timeout = 5_000 });
        await confirm.ClickAsync();

        try
        {
            await Assertions.Expect(page.GetByTestId("insufficient-balance-top-up"))
                .ToBeVisibleAsync(new() { Timeout = 10_000 });
            await Assertions.Expect(page.GetByText("No regular collateral proofs are available for CTF split."))
                .Not.ToBeVisibleAsync(new() { Timeout = 1_000 });
            await Assertions.Expect(page.GetByText("Insufficient balance for CTF split"))
                .Not.ToBeVisibleAsync(new() { Timeout = 1_000 });
        }
        catch
        {
            throw await TestHelpers.BuildDiagnosticExceptionAsync(
                page,
                consoleMessages,
                $"Expected preflight split buy for {conditionId}-{outcomeSetId} to open the top-up modal.");
        }
    }

    private static async Task<bool> TryWaitForSignalRInvocationAsync(
        IReadOnlyList<string> consoleMessages,
        string target,
        string expectedFragment,
        TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(5));
        while (DateTime.UtcNow < deadline)
        {
            if (consoleMessages.Any(message =>
                    message.Contains($"[e2e-signalr-send] {target}", StringComparison.Ordinal)
                    && message.Contains(expectedFragment, StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
            await Task.Delay(100);
        }

        return false;
    }

    private static async Task WaitForBrowserTradeConfirmedAsync(
        string tradeId,
        IReadOnlyList<(IPage Page, IReadOnlyList<string> Console)> browsers)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (DateTime.UtcNow < deadline)
        {
            AssertNoForbiddenBrowserConsole(browsers.Select(browser => browser.Console).ToArray());
            if (browsers.Any(browser => browser.Console.Any(message =>
                    message.Contains(tradeId, StringComparison.OrdinalIgnoreCase)
                    && message.Contains("Confirmed", StringComparison.OrdinalIgnoreCase))))
            {
                return;
            }
            var liveSwapState = await ReadBrowserSwapDiagnosticsAsync(
                tradeId,
                browsers.Select(browser => browser.Page));
            if (liveSwapState.Contains("\"step\":\"completed\"", StringComparison.Ordinal))
            {
                return;
            }
            if (AllWatchedBrowserSwapWorkCompleted(liveSwapState, browsers.Count, tradeId))
            {
                return;
            }
            if (liveSwapState.Contains("\"step\":\"failed\"", StringComparison.Ordinal))
            {
                throw new TimeoutException(
                    $"Browser trade {tradeId} failed before confirmation. SwapState={liveSwapState}");
            }
            await Task.Delay(500);
        }

        var tail = browsers
            .SelectMany(browser => browser.Console)
            .Where(message => message.Contains(tradeId, StringComparison.OrdinalIgnoreCase)
                              || message.Contains("Trade", StringComparison.OrdinalIgnoreCase))
            .TakeLast(20)
            .ToArray();
        var swapState = await ReadBrowserSwapDiagnosticsAsync(tradeId, browsers.Select(browser => browser.Page));
        if (AllWatchedBrowserSwapWorkCompleted(swapState, browsers.Count, tradeId))
        {
            return;
        }
        throw new TimeoutException(
            $"Browser trade {tradeId} did not reach CONFIRMED. " +
            $"SwapState={swapState}. Tail={JsonSerializer.Serialize(tail)}");
    }

    private static bool AllWatchedBrowserSwapWorkCompleted(
        string serializedSnapshots,
        int browserCount,
        string tradeId)
    {
        try
        {
            using var doc = JsonDocument.Parse(serializedSnapshots);
            if (doc.RootElement.ValueKind != JsonValueKind.Array)
                return false;
            var snapshots = doc.RootElement.EnumerateArray().ToArray();
            if (snapshots.Length != browserCount || snapshots.Length == 0)
                return false;
            return snapshots.All(snapshot =>
                snapshot.TryGetProperty("activeTrade", out var activeTrade)
                && activeTrade.ValueKind == JsonValueKind.Null
                && snapshot.TryGetProperty("activeTradeIds", out var activeTradeIds)
                && activeTradeIds.ValueKind == JsonValueKind.Array
                && !activeTradeIds.EnumerateArray().Any()
                && snapshot.TryGetProperty("proofSummary", out var proofSummary)
                && proofSummary.TryGetProperty("operations", out var operations)
                && operations.ValueKind == JsonValueKind.Array
                && operations.EnumerateArray().Any(operation =>
                    operation.TryGetProperty("operationId", out var operationId)
                    && operationId.ValueKind == JsonValueKind.String
                    && operationId.GetString()?.StartsWith(
                        $"{tradeId}/browser/",
                        StringComparison.Ordinal) == true
                    && operationId.GetString()?.EndsWith(
                        "-claim",
                        StringComparison.Ordinal) == true
                    && operation.TryGetProperty("state", out var state)
                    && state.ValueKind == JsonValueKind.String
                    && string.Equals(
                        state.GetString(),
                        "completed",
                        StringComparison.Ordinal)));
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static async Task<string> ReadBrowserSwapDiagnosticsAsync(
        string tradeId,
        IEnumerable<IPage> pages)
    {
        var snapshots = new List<object?>();
        foreach (var page in pages)
        {
            try
            {
                var snapshot = await page.EvaluateAsync<object?>(
                    @"async (tradeId) => {
                        const appDiagnostics =
                            window.__BITCASTER_E2E__?.getSwapDiagnostics?.(tradeId)
                            ?? {
                                activeTrade: null,
                                activeTradeIds: [],
                                pendingOrderIds: [],
                                pendingTrades: {}
                            };
                        const req = indexedDB.open('bitcaster');
                        const db = await new Promise((resolve, reject) => {
                            req.onsuccess = () => resolve(req.result);
                            req.onerror = () => reject(req.error);
                            req.onupgradeneeded = () => {};
                        });
                        let proofSummary = { total: 0, baseAvailable: 0, baseReserved: 0, rows: [], operations: [] };
                        try {
                            if (db.objectStoreNames.contains('proofs')) {
                                const tx = db.transaction('proofs', 'readonly');
                                const store = tx.objectStore('proofs');
                                const proofs = await new Promise((resolve, reject) => {
                                    const r = store.getAll();
                                    r.onsuccess = () => resolve(r.result);
                                    r.onerror = () => reject(r.error);
                                });
                                const isBase = (p) =>
                                    !p.marketId &&
                                    !p.conditionId &&
                                    !p.condition_id &&
                                    !p.outcomeCollection &&
                                    !p.outcome_collection;
                                proofSummary = {
                                    total: proofs.reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
                                    baseAvailable: proofs
                                        .filter((p) => isBase(p) && !p.reservedBy)
                                        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
                                    baseReserved: proofs
                                        .filter((p) => isBase(p) && p.reservedBy)
                                        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0),
                                    rows: proofs.map((p) => ({
                                        amount: Number(p.amount ?? 0),
                                        id: p.id,
                                        reservedBy: p.reservedBy ?? null,
                                        conditionId: p.conditionId ?? p.condition_id ?? null,
                                        outcomeCollection: p.outcomeCollection ?? p.outcome_collection ?? null
                                    })),
                                    operations: []
                                };
                            }
                            if (db.objectStoreNames.contains('proofOperations')) {
                                const tx = db.transaction('proofOperations', 'readonly');
                                const store = tx.objectStore('proofOperations');
                                const operations = await new Promise((resolve, reject) => {
                                    const r = store.getAll();
                                    r.onsuccess = () => resolve(r.result);
                                    r.onerror = () => reject(r.error);
                                });
                                proofSummary.operations = operations.map((op) => ({
                                    operationId: op.operationId,
                                    kind: op.kind,
                                    state: op.state,
                                    inputAmounts: (op.inputs ?? []).map((p) => Number(p.amount ?? 0)),
                                    resultKeys: op.resultProofs ? Object.keys(op.resultProofs) : []
                                }));
                            }
                        } finally {
                            db.close();
                        }
                        return {
                            url: window.location.href,
                            activeTrade: appDiagnostics.activeTrade,
                            activeTradeIds: appDiagnostics.activeTradeIds,
                            pendingOrderIds: appDiagnostics.pendingOrderIds,
                            pendingTrades: appDiagnostics.pendingTrades,
                            proofSummary
                        };
                    }",
                    tradeId);
                snapshots.Add(snapshot);
            }
            catch (Exception ex)
            {
                snapshots.Add(new { error = ex.Message });
            }
        }
        return JsonSerializer.Serialize(snapshots, BrowserDiagnosticJsonOptions);
    }

    private static void AssertNoForbiddenBrowserConsole(params IReadOnlyList<string>[] consoleLogs)
    {
        var forbidden = new[]
        {
            "Inputs must use the same conditional keyset",
            "Token Already Spent",
        };
        var hit = consoleLogs
            .SelectMany(log => log)
            .FirstOrDefault(message => forbidden.Any(term =>
                message.Contains(term, StringComparison.OrdinalIgnoreCase)));
        Assert.True(hit is null, $"Forbidden browser console error was observed: {hit}");
    }

    private static async Task ClickBuyNoAsync(IPage page, string outcomeRow)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            var outcomeButton = TradeOutcomeButton(page, outcomeRow, complement: true);
            await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
            try
            {
                await outcomeButton.ClickAsync(new() { Force = true, Timeout = 1_000 });
            }
            catch (Exception ex)
            {
                lastError = ex;
                try
                {
                    var outcomeHandle = await outcomeButton.ElementHandleAsync(new() { Timeout = 1_000 });
                    if (outcomeHandle is not null)
                    {
                        await outcomeHandle.EvaluateAsync("button => button.click()");
                    }
                }
                catch (Exception fallbackEx)
                {
                    lastError = fallbackEx;
                }
            }

            if (await TradeAmountInput(page).CountAsync() > 0)
            {
                return;
            }

            await Task.Delay(250);
        }

        if (lastError is not null)
        {
            throw lastError;
        }
    }

    private static async Task EnsureMarketDetailOpenAsync(
        IPage page,
        string conditionId,
        IReadOnlyList<string> consoleMessages)
    {
        var expectedPath = $"/markets/{conditionId}";
        for (var attempt = 0; attempt < 4; attempt++)
        {
            try
            {
                await Assertions.Expect(VisibleTradingPanel(page))
                    .ToBeVisibleAsync(new() { Timeout = 15_000 });
                if (page.Url.Contains(expectedPath, StringComparison.Ordinal))
                {
                    return;
                }
            }
            catch
            {
                // Retry the detail URL once before building the full page diagnostic.
            }

            await page.GotoAsync($"{TestPorts.FrontendUrl}{expectedPath}", new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 30_000,
            });
        }

        throw await TestHelpers.BuildDiagnosticExceptionAsync(
            page,
            consoleMessages,
            $"Market detail trading panel did not render for {conditionId}.");
    }

    private static ILocator VisibleTradingPanel(IPage page) =>
        page.Locator("[data-trading-panel]")
            .Filter(new() { Visible = true })
            .First;

    private static ILocator TradeAmountInput(IPage page) =>
        VisibleTradingPanel(page).GetByTestId("trade-amount-input")
            .Filter(new() { Visible = true })
            .First;

    private static ILocator TradeConfirmButton(IPage page) =>
        VisibleTradingPanel(page).GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;

    // The frontend trade ticket is share-denominated: the amount input takes
    // display shares and the wire amountSats is shares × share face. Share face
    // is intentionally decoupled from market divisibility; sat markets use
    // 1,000,000 msat subunits per displayed share. Convert the wire face amount
    // the assertions expect into the share count the UI wants.
    private static int ToDisplayShares(int faceAmountSubunits)
    {
        Assert.True(
            faceAmountSubunits > 0 && faceAmountSubunits % SatShareFaceSubunits == 0,
            $"faceAmountSubunits={faceAmountSubunits} is not a positive multiple of {SatShareFaceSubunits}; " +
            "the browser trade ticket can only express whole display shares.");
        return faceAmountSubunits / SatShareFaceSubunits;
    }

    private static async Task FillNumberInputAsync(ILocator input, int value)
    {
        var text = value.ToString(CultureInfo.InvariantCulture);
        Exception? lastError = null;
        for (var attempt = 0; attempt < 5; attempt++)
        {
            try
            {
                await input.FillAsync(text, new() { Timeout = 1_000 });
            }
            catch (Exception ex)
            {
                lastError = ex;
                try
                {
                    var handle = await input.ElementHandleAsync(new() { Timeout = 1_000 });
                    if (handle is not null)
                    {
                        await handle.EvaluateAsync(
                            @"(element, nextValue) => {
                                const setter = Object.getOwnPropertyDescriptor(
                                    window.HTMLInputElement.prototype,
                                    'value'
                                ).set;
                                setter.call(element, String(nextValue));
                                element.dispatchEvent(new Event('input', { bubbles: true }));
                                element.dispatchEvent(new Event('change', { bubbles: true }));
                            }",
                            text);
                    }
                }
                catch (Exception fallbackEx)
                {
                    lastError = fallbackEx;
                }
            }

            try
            {
                if (await input.InputValueAsync(new() { Timeout = 1_000 }) == text)
                {
                    return;
                }
            }
            catch (Exception ex)
            {
                lastError = ex;
            }

            await Task.Delay(250);
        }

        if (lastError is not null)
        {
            throw lastError;
        }
    }

    private static ILocator TradeOutcomeButton(IPage page, string outcomeSetId, bool complement = false)
    {
        if (string.Equals(outcomeSetId, "yes", StringComparison.OrdinalIgnoreCase))
        {
            return VisibleTradingPanel(page).GetByTestId("trade-outcome-yes")
                .Filter(new() { Visible = true })
                .First;
        }

        if (string.Equals(outcomeSetId, "no", StringComparison.OrdinalIgnoreCase))
        {
            return VisibleTradingPanel(page).GetByTestId("trade-outcome-no")
                .Filter(new() { Visible = true })
                .First;
        }

        var testId = $"{(complement ? "buy-no" : "buy-yes")}-{outcomeSetId}";
        return page.GetByTestId(testId)
            .Filter(new() { Visible = true })
            .First;
    }

    private static async Task WaitForEngineAskAsync(string marketId, int minimumAmountSats)
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow.AddSeconds(10);
        string? lastBody = null;
        while (DateTime.UtcNow < deadline)
        {
            using var response = await httpClient.GetAsync(
                $"{TestPorts.ServerUrl}/api/v1/{Uri.EscapeDataString(marketId)}/orderbook");
            lastBody = await response.Content.ReadAsStringAsync();
            if (response.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(lastBody);
                var askAmount = doc.RootElement.GetProperty("asks")
                    .EnumerateArray()
                    .Sum(ask => ask.GetProperty("amount").GetInt32());
                if (askAmount >= minimumAmountSats) return;
            }
            await Task.Delay(250);
        }

        throw new TimeoutException(
            $"Engine did not expose daemon seller ask for {marketId}. Last orderbook={lastBody ?? "(none)"}");
    }

    private static async Task WaitForEngineBidAsync(string marketId, int minimumAmountSats)
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var deadline = DateTime.UtcNow.AddSeconds(10);
        string? lastBody = null;
        while (DateTime.UtcNow < deadline)
        {
            using var response = await httpClient.GetAsync(
                $"{TestPorts.ServerUrl}/api/v1/{Uri.EscapeDataString(marketId)}/orderbook");
            lastBody = await response.Content.ReadAsStringAsync();
            if (response.IsSuccessStatusCode)
            {
                using var doc = JsonDocument.Parse(lastBody);
                var bidAmount = doc.RootElement.GetProperty("bids")
                    .EnumerateArray()
                    .Sum(bid => bid.GetProperty("amount").GetInt32());
                if (bidAmount >= minimumAmountSats) return;
            }
            await Task.Delay(250);
        }

        throw new TimeoutException(
            $"Engine did not expose maker bid for {marketId}. Last orderbook={lastBody ?? "(none)"}");
    }

    private static async Task WaitForBrowserOutcomeProofsAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        IReadOnlyList<string> consoleMessages,
        int minimumSats = 1,
        bool availableOnly = false,
        bool reservedOnly = false)
    {
        if (availableOnly && reservedOnly)
            throw new ArgumentException("Outcome proof query cannot be both availableOnly and reservedOnly.");

        var outcomeCollections = OutcomeCollectionsForProofAssertion(outcomeSetId);
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var lastSums = outcomeCollections.ToDictionary(outcome => outcome, _ => 0);
        while (DateTime.UtcNow < deadline)
        {
            foreach (var outcomeCollection in outcomeCollections)
            {
                var marketId = $"{conditionId}-{outcomeCollection}";
                lastSums[outcomeCollection] = await SumBrowserOutcomeProofsAsync(
                    page,
                    marketId,
                    availableOnly,
                    reservedOnly);
            }
            if (outcomeCollections.All(outcome => lastSums[outcome] >= minimumSats)) return;
            await Task.Delay(500);
        }

        throw await TestHelpers.BuildDiagnosticExceptionAsync(
            page,
            consoleMessages,
            $"Browser did not persist local outcome proofs for {conditionId}-{outcomeSetId}. availableOnly={availableOnly}, reservedOnly={reservedOnly}, expected each collection >= {minimumSats}, last sums={JsonSerializer.Serialize(lastSums)}.");
    }

    private static async Task WaitForBrowserExactOutcomeProofsAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        IReadOnlyList<string> consoleMessages,
        int minimumSats,
        bool availableOnly = false,
        bool reservedOnly = false)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var marketId = $"{conditionId}-{outcomeSetId}";
        var lastSum = 0;
        while (DateTime.UtcNow < deadline)
        {
            lastSum = await SumBrowserOutcomeProofsAsync(
                page,
                marketId,
                availableOnly,
                reservedOnly);
            if (lastSum >= minimumSats) return;
            await Task.Delay(500);
        }

        throw await TestHelpers.BuildDiagnosticExceptionAsync(
            page,
            consoleMessages,
            $"Browser did not persist exact local outcome proofs for {marketId}. availableOnly={availableOnly}, reservedOnly={reservedOnly}, expected >= {minimumSats}, last sum={lastSum}.");
    }

    private static async Task WaitForBrowserExactOutcomeSatsAsync(
        IPage page,
        string conditionId,
        string outcomeSetId,
        IReadOnlyList<string> consoleMessages,
        int expectedSats,
        bool availableOnly = false,
        bool reservedOnly = false)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        var marketId = $"{conditionId}-{outcomeSetId}";
        var lastSum = -1;
        while (DateTime.UtcNow < deadline)
        {
            lastSum = await SumBrowserOutcomeProofsAsync(
                page,
                marketId,
                availableOnly,
                reservedOnly);
            if (lastSum == expectedSats) return;
            await Task.Delay(250);
        }

        throw await TestHelpers.BuildDiagnosticExceptionAsync(
            page,
            consoleMessages,
            $"Browser outcome proof sum for {marketId} was {lastSum}, expected {expectedSats}.");
    }

    private static Task<int> SumBrowserOutcomeProofsAsync(
        IPage page,
        string marketId,
        bool availableOnly = false,
        bool reservedOnly = false)
    {
        var marketJson = JsonSerializer.Serialize(marketId);
        var availableOnlyJson = JsonSerializer.Serialize(availableOnly);
        var reservedOnlyJson = JsonSerializer.Serialize(reservedOnly);
        return page.EvaluateAsync<int>($@"
            async () => {{
                const expectedMarketId = {marketJson};
                const availableOnly = {availableOnlyJson};
                const reservedOnly = {reservedOnlyJson};
                const req = indexedDB.open('bitcaster');
                const db = await new Promise((resolve, reject) => {{
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                    req.onupgradeneeded = () => {{}};
                }});
                try {{
                    if (!db.objectStoreNames.contains('proofs')) return 0;
                    const tx = db.transaction('proofs', 'readonly');
                    const store = tx.objectStore('proofs');
                    const proofs = await new Promise((resolve, reject) => {{
                        const r = store.getAll();
                        r.onsuccess = () => resolve(r.result);
                        r.onerror = () => reject(r.error);
                    }});
                    return proofs
                        .filter((p) => p.marketId === expectedMarketId)
                        .filter((p) => !availableOnly || !p.reservedBy)
                        .filter((p) => !reservedOnly || !!p.reservedBy)
                        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
                }} finally {{
                    db.close();
                }}
            }}
        ");
    }

    private async Task WaitForDaemonOutcomeProofsAsync(
        DaemonHandle daemon,
        string conditionId,
        string outcomeSetId,
        int minimumSats,
        bool reserved)
    {
        var outcomeCollections = OutcomeCollectionsForProofAssertion(outcomeSetId);
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var lastAmounts = outcomeCollections.ToDictionary(outcome => outcome, _ => 0);
        string? lastBody = null;
        while (DateTime.UtcNow < deadline)
        {
            using var balance = await RunCliJsonAsync(
                daemon,
                ["wallet", "balance"],
                TimeSpan.FromSeconds(5));
            lastBody = balance.RootElement.GetRawText();
            if (balance.RootElement.GetProperty("ok").GetBoolean())
            {
                foreach (var row in balance.RootElement
                             .GetProperty("result")
                             .GetProperty("outcomePositions")
                             .EnumerateArray())
                {
                    var outcomeCollection = row.GetProperty("outcomeSetId").GetString();
                    if (row.GetProperty("conditionId").GetString() != conditionId
                        || outcomeCollection is null
                        || !lastAmounts.ContainsKey(outcomeCollection))
                    {
                        continue;
                    }

                    lastAmounts[outcomeCollection] =
                        row.GetProperty(reserved ? "reservedSats" : "availableSats").GetInt32();
                }
                if (outcomeCollections.All(outcome => lastAmounts[outcome] >= minimumSats)) return;
            }
            await Task.Delay(500);
        }

        throw new TimeoutException(
            $"Daemon wallet did not expose {(reserved ? "reserved" : "available")} outcome proofs for {conditionId}-{outcomeSetId}. " +
            $"Expected each collection >= {minimumSats}, lastAmounts={JsonSerializer.Serialize(lastAmounts)}, last={lastBody ?? "(none)"}");
    }

    private async Task WaitForDaemonExactOutcomeSatsAsync(
        DaemonHandle daemon,
        string conditionId,
        string outcomeSetId,
        int expectedAvailableSats)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var lastAmount = -1;
        string? lastBody = null;
        while (DateTime.UtcNow < deadline)
        {
            using var balance = await RunCliJsonAsync(
                daemon,
                ["wallet", "balance"],
                TimeSpan.FromSeconds(5));
            lastBody = balance.RootElement.GetRawText();
            if (balance.RootElement.GetProperty("ok").GetBoolean())
            {
                lastAmount = 0;
                foreach (var row in balance.RootElement
                             .GetProperty("result")
                             .GetProperty("outcomePositions")
                             .EnumerateArray())
                {
                    if (row.GetProperty("conditionId").GetString() == conditionId
                        && row.GetProperty("outcomeSetId").GetString() == outcomeSetId)
                    {
                        lastAmount = row.GetProperty("availableSats").GetInt32();
                        break;
                    }
                }
                if (lastAmount == expectedAvailableSats) return;
            }
            await Task.Delay(500);
        }

        throw new TimeoutException(
            $"Daemon exact outcome balance for {conditionId}-{outcomeSetId} was {lastAmount}, expected {expectedAvailableSats}. Last={lastBody ?? "(none)"}");
    }

    private async Task WaitForDaemonBaseAvailableSatsAsync(
        DaemonHandle daemon,
        int expectedAvailableSats)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        var lastBase = -1;
        string? lastBody = null;
        while (DateTime.UtcNow < deadline)
        {
            using var balance = await RunCliJsonAsync(
                daemon,
                ["wallet", "balance"],
                TimeSpan.FromSeconds(5));
            lastBody = balance.RootElement.GetRawText();
            if (balance.RootElement.GetProperty("ok").GetBoolean())
            {
                var result = balance.RootElement.GetProperty("result");
                var outcomeAvailable = result.GetProperty("outcomePositions")
                    .EnumerateArray()
                    .Sum(row => row.GetProperty("availableSats").GetInt32());
                lastBase = result.GetProperty("totalAvailableSats").GetInt32() - outcomeAvailable;
                if (lastBase == expectedAvailableSats) return;
            }
            await Task.Delay(500);
        }

        throw new TimeoutException(
            $"Daemon base available balance was {lastBase}, expected {expectedAvailableSats}. Last={lastBody ?? "(none)"}");
    }

    private async Task ReceiveOutcomeTokenAsync(
        DaemonHandle daemon,
        string conditionId,
        string outcomeSetId,
        int amountSats)
    {
        var token = await MintTokenAsync("outcome", amountSats, conditionId, outcomeSetId);
        using var receive = await RunCliJsonAsync(daemon, [
            "wallet",
            "receive",
            token,
            "--condition-id",
            conditionId,
            "--outcome-set",
            outcomeSetId,
        ]);
        Assert.True(receive.RootElement.GetProperty("ok").GetBoolean());
    }

    private async Task ReceiveSatsAsync(DaemonHandle daemon, int amountSats)
    {
        var token = await MintTokenAsync("sats", amountSats);
        using var receive = await RunCliJsonAsync(daemon, [
            "wallet",
            "receive",
            token,
        ]);
        Assert.True(receive.RootElement.GetProperty("ok").GetBoolean());
    }

    private static void AssertConsolidationResult(
        JsonDocument doc,
        string expectedType,
        int expectedCollateralReturnedSats,
        params (string Label, int Amount)[] expectedOutputs)
    {
        var raw = doc.RootElement.GetRawText();
        AssertNoProofInternals(raw);
        Assert.True(doc.RootElement.GetProperty("ok").GetBoolean());
        var result = doc.RootElement.GetProperty("result");
        Assert.Equal("consolidated", result.GetProperty("status").GetString());
        Assert.Equal(expectedType, result.GetProperty("type").GetString());
        Assert.Equal(expectedCollateralReturnedSats, result.GetProperty("collateralReturnedSats").GetInt32());

        var outputs = result.GetProperty("outputs")
            .EnumerateArray()
            .Select(row => new
            {
                Label = row.GetProperty("label").GetString() ?? "",
                Amount = row.GetProperty("amount").GetInt32(),
                Id = row.GetProperty("id").GetString() ?? "",
                KeysetId = row.GetProperty("keysetId").GetString() ?? "",
            })
            .ToArray();
        foreach (var output in outputs)
        {
            Assert.False(string.IsNullOrWhiteSpace(output.Id));
            Assert.False(string.IsNullOrWhiteSpace(output.KeysetId));
        }
        Assert.Equal(
            expectedOutputs
                .OrderBy(output => output.Label, StringComparer.Ordinal)
                .ThenBy(output => output.Amount)
                .ToArray(),
            outputs
                .Select(output => (output.Label, output.Amount))
                .OrderBy(output => output.Label, StringComparer.Ordinal)
                .ThenBy(output => output.Amount)
                .ToArray());
    }

    private static void AssertNoProofInternals(string text)
    {
        Assert.DoesNotMatch(
            new Regex("(secret|witness|mnemonic|nwc|walletSeed|nostrSecret)", RegexOptions.IgnoreCase),
            text);
    }

    private async Task AssertConsolidateNonPendingMarketRefusedAsync()
    {
        var conditionId = NewConditionId();
        await using var fakeEngine = new FakeMarketServer(conditionId, ["A", "B", "C"], status: "closed");
        var daemon = await StartDaemonAsync();
        await ConfigureDaemonEngineAsync(daemon, fakeEngine.Url);

        var result = await RunCliProcessAsync(daemon, [
            "wallet",
            "consolidate",
            $"{conditionId}-A",
            "--strategy",
            "sweep",
        ], TimeSpan.FromSeconds(10));

        Assert.NotEqual(0, result.ExitCode);
        Assert.Contains("is not pending", result.Stderr, StringComparison.OrdinalIgnoreCase);
        AssertNoProofInternals(result.Stdout);
        AssertNoProofInternals(result.Stderr);
    }

    private static string[] PrimitiveOutcomeCollections(string outcomeSetId) =>
        outcomeSetId
            .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();

    private static string[] OutcomeCollectionsForProofAssertion(string outcomeSetId) =>
        outcomeSetId.Contains('|', StringComparison.Ordinal)
            ? [outcomeSetId]
            : PrimitiveOutcomeCollections(outcomeSetId);

    private static string CanonicalOutcomeSet(IEnumerable<string> outcomes) =>
        string.Join('|', outcomes
            .Where(outcome => !string.IsNullOrWhiteSpace(outcome))
            .Select(outcome => outcome.Trim())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal));

    private async Task<JsonDocument> WaitForTradeRecordAsync(
        DaemonHandle daemon,
        string tradeId,
        Func<JsonElement, bool> predicate,
        string description)
    {
        var deadline = DateTime.UtcNow.AddSeconds(20);
        string? lastResult = null;
        while (DateTime.UtcNow < deadline)
        {
            var trade = await RunCliJsonAsync(daemon, ["trade", "watch", tradeId], TimeSpan.FromSeconds(5));
            if (trade.RootElement.GetProperty("ok").GetBoolean())
            {
                var result = trade.RootElement.GetProperty("result");
                lastResult = result.GetRawText();
                if (result.ValueKind == JsonValueKind.Object && predicate(result))
                    return trade;
            }
            trade.Dispose();
            await Task.Delay(500);
        }

        throw new TimeoutException(
            $"Trade {tradeId} did not expose {description}. Last result={lastResult ?? "(none)"}");
    }

    private static bool HasMintMetadata(
        JsonElement record,
        string expectedMarketId,
        string expectedRole,
        string sellerKeepOutcomeSetId,
        string sellerLockOutcomeSetId,
        int outcomeFaceAmountSubunits,
        int quotePaymentSats)
    {
        return record.TryGetProperty("marketId", out var marketId)
               && marketId.GetString() == expectedMarketId
               && record.TryGetProperty("role", out var role)
               && role.GetString() == expectedRole
               && record.TryGetProperty("settlementKind", out var settlementKind)
               && settlementKind.GetString() == "Mint"
               && record.TryGetProperty("sellerKeepOutcomeSetId", out var keep)
               && keep.GetString() == sellerKeepOutcomeSetId
               && record.TryGetProperty("sellerLockOutcomeSetId", out var locked)
               && locked.GetString() == sellerLockOutcomeSetId
               && record.TryGetProperty("outcomeFaceAmountSubunits", out var face)
               && face.GetInt32() == outcomeFaceAmountSubunits
               && record.TryGetProperty("quotePaymentSats", out var quote)
               && quote.GetInt32() == quotePaymentSats;
    }

    private async Task<string> MintTokenAsync(
        string mode,
        int amountSats,
        string? conditionId = null,
        string? outcomeSetId = null)
    {
        var args = new List<string>
        {
            mode,
            TestPorts.MintUrl,
            amountSats.ToString(),
        };
        if (conditionId is not null && outcomeSetId is not null)
        {
            args.Add(conditionId);
            args.Add(outcomeSetId);
        }
        var result = await RunNodeAsync(MintDaemonTokenScript, args.ToArray(), daemon: null, timeout: TimeSpan.FromSeconds(45));
        return result.Stdout.Trim();
    }

    private async Task<string?> RegisterMintConditionWithFeeAsync(
        string title,
        string description,
        string announcementHex,
        string[] outcomes)
    {
        var result = await RunNodeAsync(
            RegisterConditionScript,
            [
                TestPorts.MintUrl,
                title,
                description,
                "sat",
                JsonSerializer.Serialize(new[] { announcementHex }),
                JsonSerializer.Serialize(outcomes),
            ],
            daemon: null,
            timeout: TimeSpan.FromSeconds(60));
        using var doc = JsonDocument.Parse(result.Stdout);
        return doc.RootElement.GetProperty("condition_id").GetString();
    }

    private static int SpendableCtfSats(int faceAmountSubunits) =>
        faceAmountSubunits - InputFeeSats(faceAmountSubunits);

    private static int GrossCtfFaceAmountForSpendableSats(int spendableAmountSats)
    {
        var faceAmountSubunits = spendableAmountSats;
        while (SpendableCtfSats(SpendableCtfSats(faceAmountSubunits)) < spendableAmountSats)
        {
            faceAmountSubunits++;
        }
        return faceAmountSubunits;
    }

    private static int InputFeeSats(int amountSats) =>
        (int)Math.Ceiling(amountSats * MintInputFeePpk / 1000.0);

    private async Task<string> MintProofsJsonAsync(
        string mode,
        int amountSats,
        string? conditionId = null,
        string? outcomeSetId = null)
    {
        var args = new List<string>
        {
            mode,
            TestPorts.MintUrl,
            amountSats.ToString(),
        };
        if (conditionId is not null && outcomeSetId is not null)
        {
            args.Add(conditionId);
            args.Add(outcomeSetId);
        }
        args.Add("--json");

        var result = await RunNodeAsync(
            MintDaemonTokenScript,
            args.ToArray(),
            daemon: null,
            timeout: TimeSpan.FromSeconds(45));
        using var doc = JsonDocument.Parse(result.Stdout);
        return doc.RootElement.GetProperty("proofs").GetRawText();
    }

    private static async Task<(string ConditionId, string OutcomeSetId)> FindFundableOutcomeAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        foreach (var condition in doc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            var conditionId = condition.GetProperty("condition_id").GetString();
            if (string.IsNullOrWhiteSpace(conditionId) || conditionId.Length != 64)
                continue;
            if (!condition.TryGetProperty("keysets", out var keysets)
                || keysets.ValueKind != JsonValueKind.Object)
                continue;
            foreach (var keyset in keysets.EnumerateObject())
            {
                var outcome = PrimitiveOutcomeCollections(keyset.Name)
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
                if (!string.IsNullOrWhiteSpace(outcome))
                    return (conditionId, outcome);
            }
        }

        throw new InvalidOperationException("No fundable CTF condition/outcome was available from the mint.");
    }

    private async Task<(string ConditionId, string YesOutcomeSetId, string NoOutcomeSetId)> FindBinaryConditionAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var engineVisibleIds = await LoadTradableMarketConditionIdsAsync(httpClient);
        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);

        var seeded = EnumerateBinaryConditions(doc)
            .FirstOrDefault(condition => engineVisibleIds.Contains(condition.ConditionId)
                && condition.Title.Contains("Will Bitcoin reach $100K", StringComparison.OrdinalIgnoreCase));
        if (seeded.ConditionId is not null)
            return (seeded.ConditionId, seeded.YesOutcomeSetId, seeded.NoOutcomeSetId);

        var engineVisible = EnumerateBinaryConditions(doc)
            .FirstOrDefault(condition => engineVisibleIds.Contains(condition.ConditionId));
        if (engineVisible.ConditionId is not null)
            return (engineVisible.ConditionId, engineVisible.YesOutcomeSetId, engineVisible.NoOutcomeSetId);

        return await CreateBinaryMarketFixtureAsync(httpClient);
    }

    private static IEnumerable<(string ConditionId, string Title, string YesOutcomeSetId, string NoOutcomeSetId)> EnumerateBinaryConditions(
        JsonDocument doc)
    {
        foreach (var condition in doc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            var conditionId = condition.GetProperty("condition_id").GetString();
            if (string.IsNullOrWhiteSpace(conditionId) || conditionId.Length != 64)
                continue;
            if (!condition.TryGetProperty("keysets", out var keysets)
                || keysets.ValueKind != JsonValueKind.Object)
                continue;
            var values = keysets.EnumerateObject()
                .SelectMany(keyset => PrimitiveOutcomeCollections(keyset.Name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            var yes = values.FirstOrDefault(value => string.Equals(value, "YES", StringComparison.OrdinalIgnoreCase));
            var no = values.FirstOrDefault(value => string.Equals(value, "NO", StringComparison.OrdinalIgnoreCase));
            if (yes is not null && no is not null)
                yield return (conditionId, ReadConditionTitle(condition), yes, no);
        }
    }

    private async Task<(string ConditionId, string[] PrimitiveOutcomeSetIds)> FindCategoricalConditionAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        if (EnvFlag("BITCASTER_E2E_FORCE_CREATE_CATEGORICAL_MARKET"))
            return await CreateCategoricalMarketFixtureAsync(httpClient);

        var tradableConditionIds = await LoadTradableMarketConditionIdsAsync(httpClient);
        var existing = await TryFindCategoricalConditionAsync(httpClient, tradableConditionIds);
        if (existing is not null)
            return existing.Value;

        if (EnvFlag("BITCASTER_E2E_CREATE_CATEGORICAL_MARKET"))
        {
            var created = await CreateCategoricalMarketFixtureAsync(httpClient);
            var refreshed = await TryFindCategoricalConditionAsync(
                httpClient,
                await LoadTradableMarketConditionIdsAsync(httpClient));
            if (refreshed is not null && refreshed.Value.ConditionId == created.ConditionId)
                return refreshed.Value;
            return created;
        }

        if (EnvFlag("BITCASTER_E2E_REQUIRE_OPEN_CATEGORICAL_MARKET"))
            throw new InvalidOperationException(
                "No open engine-registered categorical CTF condition was available. " +
                "Set BITCASTER_E2E_CREATE_CATEGORICAL_MARKET=1 to seed one before the smoke.");

        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        var fallback = EnumerateCategoricalConditions(doc)
            .FirstOrDefault();
        if (fallback.ConditionId is not null)
            return fallback;

        throw new InvalidOperationException("No categorical CTF condition with at least three outcomes was available from the mint.");
    }

    private static async Task<(string ConditionId, string[] PrimitiveOutcomeSetIds)?> TryFindCategoricalConditionAsync(
        HttpClient httpClient,
        HashSet<string> tradableConditionIds)
    {
        if (tradableConditionIds.Count == 0)
            return null;

        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        return EnumerateCategoricalConditions(doc)
            .FirstOrDefault(condition => tradableConditionIds.Contains(condition.ConditionId));
    }

    private static IEnumerable<(string ConditionId, string[] PrimitiveOutcomeSetIds)> EnumerateCategoricalConditions(
        JsonDocument doc)
    {
        foreach (var condition in doc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            var conditionId = condition.GetProperty("condition_id").GetString();
            if (string.IsNullOrWhiteSpace(conditionId) || conditionId.Length != 64)
                continue;
            if (!condition.TryGetProperty("keysets", out var keysets)
                || keysets.ValueKind != JsonValueKind.Object)
                continue;
            var observedCollections = new HashSet<string>(StringComparer.Ordinal);
            foreach (var keyset in keysets.EnumerateObject())
            {
                observedCollections.Add(keyset.Name);
            }
            var primitives = observedCollections
                .SelectMany(PrimitiveOutcomeCollections)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray();
            if (primitives.Length >= 3)
                yield return (conditionId, primitives);
        }
    }

    private async Task<(string ConditionId, string[] PrimitiveOutcomeSetIds)> CreateCategoricalMarketFixtureAsync(
        HttpClient httpClient,
        string[]? outcomes = null,
        bool registerEngine = true,
        string? titlePrefix = null)
    {
        outcomes ??= ["A", "B", "C"];
        outcomes = outcomes
            .Where(outcome => !string.IsNullOrWhiteSpace(outcome))
            .Select(outcome => outcome.Trim())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
        if (outcomes.Length < 3)
            throw new ArgumentException("Categorical fixture requires at least three outcomes.", nameof(outcomes));

        var unique = Guid.NewGuid().ToString("N")[..8];
        var title = $"{titlePrefix ?? "P23-4 staging categorical smoke"} {unique}";
        var description = "Synthetic open categorical market created by the multi-outcome mint swap smoke.";
        var announcementHex = await BuildTestEnumAnnouncementHexAsync(
            outcomes,
            $"p23-4-categorical-smoke-{unique}",
            DateTimeOffset.UtcNow.AddMonths(6));

        var conditionId = await RegisterMintConditionWithFeeAsync(
            title,
            description,
            announcementHex,
            outcomes);
        if (string.IsNullOrWhiteSpace(conditionId))
            throw new InvalidOperationException("Mint condition registration returned an empty condition_id.");

        if (!registerEngine)
            return (conditionId, outcomes);

        var metadata = new
        {
            title,
            description,
            outcomes = EqualProbabilityOutcomes(outcomes),
            outcomeType = "categorical",
            liquiditySubunits = 0,
            categoryTags = new[] { "qa" },
            oracleAnnouncementHex = announcementHex,
        };
        using var form = new MultipartFormDataContent
        {
            {
                new StringContent(
                    JsonSerializer.Serialize(metadata, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
                    Encoding.UTF8,
                    "application/json"),
                "metadata"
            }
        };
        var bodyBytes = await form.ReadAsByteArrayAsync();
        var createUrl = $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}";
        using var request = new HttpRequestMessage(HttpMethod.Post, createUrl);
        request.Headers.Add("Authorization", CreateNip98AuthHeader("POST", createUrl, bodyBytes));
        request.Content = new ByteArrayContent(bodyBytes);
        foreach (var header in form.Headers)
            request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);

        using var createResponse = await httpClient.SendAsync(request);
        if (!createResponse.IsSuccessStatusCode && createResponse.StatusCode != HttpStatusCode.Conflict)
            throw new InvalidOperationException(
                $"Engine categorical market fixture registration failed: " +
                $"{createResponse.StatusCode} {await createResponse.Content.ReadAsStringAsync()}");

        return (conditionId, outcomes);
    }

    private async Task<(string ConditionId, string YesOutcomeSetId, string NoOutcomeSetId)> CreateBinaryMarketFixtureAsync(
        HttpClient httpClient,
        string? titlePrefix = null)
    {
        string[] outcomes = ["Yes", "No"];
        var unique = Guid.NewGuid().ToString("N")[..8];
        var title = $"{titlePrefix ?? "E2E binary direct"} {unique}";
        var description = "Synthetic open binary market created by the direct settlement smoke.";
        var announcementHex = await BuildTestEnumAnnouncementHexAsync(
            outcomes,
            $"e2e-binary-direct-{unique}",
            DateTimeOffset.UtcNow.AddMonths(6));

        var conditionId = await RegisterMintConditionWithFeeAsync(
            title,
            description,
            announcementHex,
            outcomes);
        if (string.IsNullOrWhiteSpace(conditionId))
            throw new InvalidOperationException("Mint condition registration returned an empty condition_id.");

        var metadata = new
        {
            title,
            description,
            outcomes = EqualProbabilityOutcomes(outcomes),
            outcomeType = "yesno",
            liquiditySubunits = 0,
            categoryTags = new[] { "qa" },
            oracleAnnouncementHex = announcementHex,
        };
        using var form = new MultipartFormDataContent
        {
            {
                new StringContent(
                    JsonSerializer.Serialize(metadata, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
                    Encoding.UTF8,
                    "application/json"),
                "metadata"
            }
        };
        var bodyBytes = await form.ReadAsByteArrayAsync();
        var createUrl = $"{TestPorts.ServerUrl}/api/v1/markets/{conditionId}";
        using var request = new HttpRequestMessage(HttpMethod.Post, createUrl);
        request.Headers.Add("Authorization", CreateNip98AuthHeader("POST", createUrl, bodyBytes));
        request.Content = new ByteArrayContent(bodyBytes);
        foreach (var header in form.Headers)
            request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value);

        using var createResponse = await httpClient.SendAsync(request);
        if (!createResponse.IsSuccessStatusCode && createResponse.StatusCode != HttpStatusCode.Conflict)
            throw new InvalidOperationException(
                $"Engine binary market fixture registration failed: " +
                $"{createResponse.StatusCode} {await createResponse.Content.ReadAsStringAsync()}");

        return (conditionId, "Yes", "No");
    }

    private static string[] RequiredOutcomeCollections(string[] outcomes)
    {
        return outcomes
            .Concat(outcomes.Select(outcome => ComplementOutcomeSet(outcomes, outcome)))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray();
    }

    private static string ComplementOutcomeSet(string[] outcomes, string excludedOutcome) =>
        CanonicalOutcomeSet(outcomes.Where(outcome => outcome != excludedOutcome));

    private static object[] EqualProbabilityOutcomes(string[] outcomes)
    {
        var baseProbability = 100 / outcomes.Length;
        var remaining = 100;
        return outcomes
            .Select((outcome, index) =>
            {
                var probability = index == outcomes.Length - 1
                    ? remaining
                    : baseProbability;
                remaining -= probability;
                return new { name = outcome, probability };
            })
            .Cast<object>()
            .ToArray();
    }

    private static HashSet<string> ReadConditionKeysetLabels(JsonDocument doc, string conditionId)
    {
        var labels = new HashSet<string>(StringComparer.Ordinal);
        foreach (var condition in doc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            if (condition.GetProperty("condition_id").GetString() != conditionId)
                continue;
            if (!condition.TryGetProperty("keysets", out var keysets)
                || keysets.ValueKind != JsonValueKind.Object)
                return labels;
            foreach (var keyset in keysets.EnumerateObject())
            {
                labels.Add(keyset.Name);
            }
            return labels;
        }
        return labels;
    }

    private static bool EnvFlag(string name)
    {
        var value = Environment.GetEnvironmentVariable(name);
        return string.Equals(value, "1", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "true", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "yes", StringComparison.OrdinalIgnoreCase);
    }

    private static string CreateNip98AuthHeader(string method, string signedUrl, byte[]? body)
    {
        const int nip98Kind = 27235;
        var key = new Key();
        var keyPair = key.CreateTaprootKeyPair();
        var pubkey = Convert.ToHexString(keyPair.PubKey.ToBytes()).ToLowerInvariant();
        var tags = new List<List<string>>
        {
            new() { "u", signedUrl },
            new() { "method", method.ToUpperInvariant() },
        };

        if (string.Equals(method, "POST", StringComparison.OrdinalIgnoreCase)
            || string.Equals(method, "PUT", StringComparison.OrdinalIgnoreCase)
            || string.Equals(method, "PATCH", StringComparison.OrdinalIgnoreCase))
        {
            var hash = SHA256.HashData(body ?? []);
            tags.Add(["payload", Convert.ToHexString(hash).ToLowerInvariant()]);
        }

        var createdAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var serializedForId = JsonSerializer.Serialize(
            new object[] { 0, pubkey, createdAt, nip98Kind, tags, "" });
        var eventId = Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(serializedForId)))
            .ToLowerInvariant();
        var sig = key
            .SignTaprootKeySpend(new uint256(Convert.FromHexString(eventId)), TaprootSigHash.Default)
            .SchnorrSignature
            .ToBytes();

        var ev = new Nip98Event
        {
            Id = eventId,
            Pubkey = pubkey,
            CreatedAt = createdAt,
            Kind = nip98Kind,
            Tags = tags,
            Content = "",
            Sig = Convert.ToHexString(sig).ToLowerInvariant(),
        };
        var json = JsonSerializer.Serialize(ev);
        return $"Nostr {Convert.ToBase64String(Encoding.UTF8.GetBytes(json))}";
    }

    private async Task<string> BuildTestEnumAnnouncementHexAsync(
        string[] outcomes,
        string eventId,
        DateTimeOffset maturity)
    {
        var result = await RunCargoAsync(
            [
                "run",
                "--quiet",
                "--manifest-path",
                "dlcdevkit/Cargo.toml",
                "-p",
                "kormir",
                "--example",
                "bitcaster_create_enum",
                "--",
                eventId,
                checked(((uint)maturity.ToUnixTimeSeconds()).ToString(CultureInfo.InvariantCulture)),
                JsonSerializer.Serialize(outcomes),
            ],
            timeout: TimeSpan.FromSeconds(90));
        return result.Stdout.Trim();
    }

    private async Task<ProcessResult> RunCargoAsync(
        string[] args,
        TimeSpan? timeout = null)
    {
        var result = await RunProcessAsync(
            "cargo",
            args,
            _repoRoot,
            timeout ?? TimeSpan.FromSeconds(60));
        if (result.ExitCode != 0)
            throw new InvalidOperationException(
                $"cargo {string.Join(' ', args)} exited {result.ExitCode}\n" +
                $"stdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return result;
    }

    private static async Task<ProcessResult> RunProcessAsync(
        string fileName,
        string[] args,
        string workingDirectory,
        TimeSpan timeout)
    {
        using var process = StartProcess(fileName, args, workingDirectory);
        using var cts = new CancellationTokenSource(timeout);
        try
        {
            var stdoutTask = process.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(cts.Token);
            await process.WaitForExitAsync(cts.Token);
            return new ProcessResult(
                process.ExitCode,
                await stdoutTask,
                await stderrTask);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new TimeoutException($"Timed out running {fileName}");
        }
    }

    private static Process StartProcess(
        string fileName,
        string[] args,
        string workingDirectory)
    {
        var startInfo = new ProcessStartInfo(fileName)
        {
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);
        return Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start {fileName}");
    }

    private static async Task<HashSet<string>> LoadTradableMarketConditionIdsAsync(HttpClient httpClient)
    {
        try
        {
            using var response = await httpClient.GetAsync($"{TestPorts.ServerUrl}/api/v1/markets/query?state=All&limit=500");
            if (!response.IsSuccessStatusCode)
                return [];

            await using var stream = await response.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            var now = DateTimeOffset.UtcNow;
            return doc.RootElement.GetProperty("markets")
                .EnumerateArray()
                .Where(market =>
                    market.TryGetProperty("conditionId", out var conditionId)
                    && conditionId.ValueKind == JsonValueKind.String
                    && market.TryGetProperty("state", out var state)
                    && string.Equals(state.GetString(), "open", StringComparison.OrdinalIgnoreCase)
                    && market.TryGetProperty("deadline", out var deadline)
                    && DateTimeOffset.TryParse(deadline.GetString(), out var deadlineAt)
                    && deadlineAt > now)
                .Select(market => market.GetProperty("conditionId").GetString()!)
                .ToHashSet(StringComparer.Ordinal);
        }
        catch
        {
            return [];
        }
    }

    private static async Task<HashSet<string>> LoadCatalogueConditionIdsAsync(HttpClient httpClient)
    {
        try
        {
            using var response = await httpClient.GetAsync($"{TestPorts.ServerUrl}/api/v1/markets/query?state=All&limit=500");
            if (!response.IsSuccessStatusCode)
                return [];

            await using var stream = await response.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            return doc.RootElement.GetProperty("markets")
                .EnumerateArray()
                .Where(market =>
                    market.TryGetProperty("conditionId", out var conditionId)
                    && conditionId.ValueKind == JsonValueKind.String)
                .Select(market => market.GetProperty("conditionId").GetString()!)
                .ToHashSet(StringComparer.Ordinal);
        }
        catch
        {
            return [];
        }
    }

    private static string ReadConditionTitle(JsonElement condition)
    {
        if (condition.TryGetProperty("tags", out var tags) && tags.ValueKind == JsonValueKind.Array)
        {
            string? description = null;
            foreach (var entry in tags.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Array)
                    continue;
                var values = entry.EnumerateArray().ToArray();
                if (values.Length < 2)
                    continue;
                var key = values[0].GetString();
                var value = values[1].GetString();
                if (key == "title" && !string.IsNullOrWhiteSpace(value))
                    return value;
                if (key == "description" && !string.IsNullOrWhiteSpace(value))
                    description ??= value;
            }
            if (!string.IsNullOrWhiteSpace(description))
                return description;
        }

        if (condition.TryGetProperty("description", out var legacy))
            return legacy.GetString() ?? string.Empty;
        return string.Empty;
    }

    private async Task<ProcessResult> RunNodeAsync(
        string script,
        string[] args,
        DaemonHandle? daemon,
        TimeSpan? timeout = null)
    {
        var result = await RunNodeProcessAsync(script, args, daemon, timeout);
        if (result.ExitCode != 0)
            throw new InvalidOperationException(
                $"node {Path.GetFileName(script)} exited {result.ExitCode}\n" +
                $"stdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
        return result;
    }

    private async Task<ProcessResult> RunNodeProcessAsync(
        string script,
        string[] args,
        DaemonHandle? daemon,
        TimeSpan? timeout = null)
    {
        using var process = StartNode(script, args, daemon);
        using var cts = new CancellationTokenSource(timeout ?? TimeSpan.FromSeconds(20));
        try
        {
            var stdoutTask = process.StandardOutput.ReadToEndAsync(cts.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(cts.Token);
            await process.WaitForExitAsync(cts.Token);
            var result = new ProcessResult(
                process.ExitCode,
                await stdoutTask,
                await stderrTask);
            return result;
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            throw new TimeoutException($"Timed out running node {Path.GetFileName(script)}");
        }
    }

    private static async Task WaitForBrowserBaseProofsAsync(
        IPage page,
        int minimumSats,
        IReadOnlyList<string> consoleMessages)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var lastSum = 0;
        while (DateTime.UtcNow < deadline)
        {
            lastSum = await SumBrowserBaseProofsAsync(page);
            if (lastSum >= minimumSats) return;
            await Task.Delay(500);
        }

        throw await TestHelpers.BuildDiagnosticExceptionAsync(
            page,
            consoleMessages,
            $"Browser deposit did not persist base proofs. Expected >= {minimumSats}, last sum={lastSum}.");
    }

    private static Task<int> SumBrowserBaseProofsAsync(IPage page)
    {
        return page.EvaluateAsync<int>("""
            async () => {
                const req = indexedDB.open('bitcaster');
                const db = await new Promise((resolve, reject) => {
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                    req.onupgradeneeded = () => {};
                });
                try {
                    if (!db.objectStoreNames.contains('proofs')) return 0;
                    const tx = db.transaction('proofs', 'readonly');
                    const store = tx.objectStore('proofs');
                    const proofs = await new Promise((resolve, reject) => {
                        const r = store.getAll();
                        r.onsuccess = () => resolve(r.result);
                        r.onerror = () => reject(r.error);
                    });
                    return proofs
                        .filter((p) =>
                            !p.marketId &&
                            !p.conditionId &&
                            !p.condition_id &&
                            !p.outcomeCollection &&
                            !p.outcome_collection)
                        .reduce((sum, p) => sum + Number(p.amount ?? 0), 0);
                } finally {
                    db.close();
                }
            }
        """);
    }

    private Process StartNode(string script, string[] args, DaemonHandle? daemon)
    {
        var startInfo = new ProcessStartInfo("node")
        {
            WorkingDirectory = _repoRoot,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--experimental-strip-types");
        startInfo.ArgumentList.Add(script);
        foreach (var arg in args)
            startInfo.ArgumentList.Add(arg);

        if (daemon is not null)
        {
            startInfo.Environment["BITCASTER_DAEMON_HOME"] = daemon.Home;
            startInfo.Environment["BITCASTER_DAEMON_PORT"] = daemon.Port.ToString();
            startInfo.Environment["BITCASTER_DAEMON_URL"] = $"http://127.0.0.1:{daemon.Port}";
            startInfo.Environment["BITCASTER_ENGINE_URL"] = TestPorts.ServerUrl;
            startInfo.Environment["BITCASTER_MINT_URL"] = TestPorts.MintUrl;
        }

        return Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start node {script}");
    }

    private static int ReserveTcpPort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }

    private static string FindRepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null)
        {
            if (File.Exists(Path.Combine(dir.FullName, "bitcaster-cli", "src", "main.ts")))
                return dir.FullName;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("Could not locate bitCaster repo root");
    }

    private sealed class FakeMarketServer : IAsyncDisposable
    {
        private readonly HttpListener _listener = new();
        private readonly Task _loop;
        private readonly string _conditionId;
        private readonly string[] _outcomes;
        private readonly string _status;

        public FakeMarketServer(string conditionId, string[] outcomes, string status)
        {
            _conditionId = conditionId;
            _outcomes = outcomes;
            _status = status;
            var port = ReserveTcpPort();
            Url = $"http://127.0.0.1:{port}";
            _listener.Prefixes.Add($"{Url}/");
            _listener.Start();
            _loop = Task.Run(ServeAsync);
        }

        public string Url { get; }

        public async ValueTask DisposeAsync()
        {
            _listener.Stop();
            try
            {
                await _loop;
            }
            catch
            {
                // The listener is stopped to terminate the accept loop.
            }
            _listener.Close();
        }

        private async Task ServeAsync()
        {
            while (_listener.IsListening)
            {
                HttpListenerContext context;
                try
                {
                    context = await _listener.GetContextAsync();
                }
                catch when (!_listener.IsListening)
                {
                    return;
                }

                await HandleAsync(context);
            }
        }

        private async Task HandleAsync(HttpListenerContext context)
        {
            if (string.Equals(context.Request.HttpMethod, "GET", StringComparison.OrdinalIgnoreCase)
                && string.Equals(context.Request.Url?.AbsolutePath, "/api/v1/markets/query", StringComparison.Ordinal))
            {
                var now = DateTimeOffset.UtcNow;
                var body = JsonSerializer.Serialize(
                    new
                    {
                        markets = new[]
                        {
                            new
                            {
                                conditionId = _conditionId,
                                title = "Closed categorical fixture",
                                description = "Closed market fixture for CLI consolidation refusal.",
                                outcomes = _outcomes,
                                outcomeType = "categorical",
                                state = _status,
                                deadline = now.AddMonths(1),
                                closedAt = string.Equals(_status, "pending", StringComparison.OrdinalIgnoreCase)
                                    ? (DateTimeOffset?)null
                                    : now,
                                finalOutcome = "",
                                creatorPubkey = "",
                                createdAt = now.AddMinutes(-5),
                                lastSuccessfulRefreshAt = now,
                                lastTradedPrice = (double?)null,
                                liquiditySubunits = 0,
                                categoryTags = Array.Empty<string>(),
                                thumbnailUrl = "",
                                traderCount = 0,
                                volume24hSubunits = 0,
                                volume30dSubunits = 0,
                                volumeLifetimeSubunits = 0,
                            },
                        },
                        nextCursor = (string?)null,
                    },
                    new JsonSerializerOptions(JsonSerializerDefaults.Web));
                await WriteResponseAsync(context, statusCode: 200, body, "application/json");
                return;
            }

            await WriteResponseAsync(context, statusCode: 404, "not found", "text/plain");
        }

        private static async Task WriteResponseAsync(
            HttpListenerContext context,
            int statusCode,
            string body,
            string contentType)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            context.Response.StatusCode = statusCode;
            context.Response.ContentType = contentType;
            context.Response.ContentLength64 = bytes.Length;
            await context.Response.OutputStream.WriteAsync(bytes);
            context.Response.Close();
        }
    }

    private sealed record Nip98Event
    {
        [JsonPropertyName("id")] public string Id { get; init; } = "";
        [JsonPropertyName("pubkey")] public string Pubkey { get; init; } = "";
        [JsonPropertyName("created_at")] public long CreatedAt { get; init; }
        [JsonPropertyName("kind")] public int Kind { get; init; }
        [JsonPropertyName("tags")] public List<List<string>> Tags { get; init; } = [];
        [JsonPropertyName("content")] public string Content { get; init; } = "";
        [JsonPropertyName("sig")] public string Sig { get; init; } = "";
    }

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);

    private sealed record DaemonHandle(string Home, int Port)
    {
        public Process? Process { get; set; }
    }

    // -----------------------------------------------------------------------
    // P47 — red-first E2E stubs for the new CLI surface.
    //
    // These require a real AppHost + daemon + engine, so they stay in E2E.
    // Pure CLI-parsing tests (--version, --help, config path) live in the
    // CLI unit test suite (bitcaster-cli/test/cli.test.ts) instead.
    //
    // Future refactoring plan (not in scope for P47):
    //   - Split E2E into "quick regression" (cheap smoke) vs "nightly full"
    //     categories. Tests below should migrate to the appropriate category.
    //   - Rename to user-story style (e.g. UserCanSubmitOrderViaCli) and
    //     parameterize by TradingClientKind (Cli/GUI) for matrix coverage.
    // -----------------------------------------------------------------------

    [Fact]
    public async Task P47_UserCanSubmitOrderViaCli_WithNamedFlags()
    {
        var daemon = await StartDaemonAsync();
        var marketId = $"{NewConditionId()}-Yes";
        using var submit = await RunCliJsonAsync(daemon, [
            "order", "submit",
            "--market", marketId,
            "--outcome", "Yes",
            "--side", "Buy",
            "--price", "50",
            "--amount", "100",
            "--tif", "GTC",
            "--no-preflight-split",
        ], TimeSpan.FromSeconds(10));
        Assert.True(submit.RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task P47_UserCanConsolidatePositionsViaCli_WithStrategyName()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var condition = await CreateCategoricalMarketFixtureAsync(
            httpClient,
            registerEngine: false,
            titlePrefix: "P47 wallet consolidate strategy");
        await using var fakeEngine = new FakeMarketServer(
            condition.ConditionId,
            condition.PrimitiveOutcomeSetIds,
            status: "pending");
        var daemon = await StartDaemonAsync();
        await ConfigureDaemonEngineAsync(daemon, fakeEngine.Url);
        var marketId = $"{condition.ConditionId}-{condition.PrimitiveOutcomeSetIds[0]}";

        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "A", amountSats: 2);
        await ReceiveOutcomeTokenAsync(daemon, condition.ConditionId, "B", amountSats: 2);
        await ReceiveSatsAsync(daemon, amountSats: 1);

        using var result = await RunCliJsonAsync(daemon, [
            "wallet", "consolidate", marketId, "--strategy", "merge",
        ], TimeSpan.FromSeconds(30));
        AssertConsolidationResult(
            result,
            expectedType: "t1",
            expectedCollateralReturnedSats: 0,
            ("A|B", 2));
    }

    [Fact]
    public async Task P47_UserCanSplitCompleteSetViaCli_WithRenamedCommand()
    {
        var daemon = await StartDaemonAsync();
        var condition = await FindBinaryConditionAsync();
        await ReceiveSatsAsync(daemon, amountSats: 100);
        using var result = await RunCliJsonAsync(daemon, [
            "wallet", "split", condition.ConditionId, "100",
        ], TimeSpan.FromSeconds(30));
        Assert.True(result.RootElement.GetProperty("ok").GetBoolean());
    }

    [Fact]
    public async Task P47_UserSeesFriendlyError_WhenDaemonIsUnreachable()
    {
        var env = new Dictionary<string, string?>
        {
            ["BITCASTER_DAEMON_HOME"] = Path.Combine(Path.GetTempPath(), $"bitcaster-cli-no-daemon-{Guid.NewGuid():N}"),
            ["BITCASTER_DAEMON_PORT"] = "43999",
            ["BITCASTER_CLI_AUTOSTART_DAEMON"] = "0",
        };
        Directory.CreateDirectory(env["BITCASTER_DAEMON_HOME"]!);
        var result = await RunNodeProcessAsync(BitcasterCliMain, ["health"], env, TimeSpan.FromSeconds(5));
        Assert.NotEqual(0, result.ExitCode);
        Assert.Matches("daemon not reachable|daemon is not running", result.Stderr);
        Assert.DoesNotMatch("triggerUncaughtException|TypeError", result.Stderr);
    }
}
