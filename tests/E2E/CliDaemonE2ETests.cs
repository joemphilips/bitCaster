using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BitCaster.E2ETest;

/// <summary>
/// E2E coverage for the browserless frontend path introduced by P19. The test
/// starts a real bitcaster-daemon process, drives it only through
/// bitcaster-cli, and points it at the same public mock engine used by browser
/// E2E.
/// </summary>
public sealed class CliDaemonE2ETests : IAsyncLifetime
{
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
        Assert.Equal(100, statusEngine.GetProperty("remainingAmountSats").GetInt32());

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
        var conditionId = NewConditionId();
        var noMarketId = $"{conditionId}-NO";
        var yesMarketId = $"{conditionId}-YES";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            noMarketId,
            "NO",
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
            "YES",
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
        Assert.Equal(100, fill.GetProperty("outcomeFaceAmountSats").GetInt32());
        Assert.Equal(50, fill.GetProperty("quotePaymentSats").GetInt32());
        Assert.Equal("NO", fill.GetProperty("sellerKeepOutcomeSetId").GetString());
        Assert.Equal("YES", fill.GetProperty("sellerLockOutcomeSetId").GetString());
        Assert.Equal(0, takerEngine.GetProperty("remainingAmountSats").GetInt32());

        using var makerTrade = await WaitForTradeRecordAsync(
            maker,
            tradeId!,
            record => HasMintMetadata(
                record,
                yesMarketId,
                expectedRole: "seller",
                sellerKeepOutcomeSetId: "NO",
                sellerLockOutcomeSetId: "YES",
                outcomeFaceAmountSats: 100,
                quotePaymentSats: 50),
            "resting maker mint TradeCreated");
        using var takerTrade = await WaitForTradeRecordAsync(
            taker,
            tradeId!,
            record => HasMintMetadata(
                record,
                yesMarketId,
                expectedRole: "buyer",
                sellerKeepOutcomeSetId: "NO",
                sellerLockOutcomeSetId: "YES",
                outcomeFaceAmountSats: 100,
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
        var conditionId = NewConditionId();
        const string makerOutcomeSetId = "Bob|Carol";
        const string takerOutcomeSetId = "Alice";
        var makerMarketId = $"{conditionId}-{makerOutcomeSetId}";
        var takerMarketId = $"{conditionId}-{takerOutcomeSetId}";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            makerOutcomeSetId,
            "Buy",
            "60",
            "100",
            "GTC",
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
        Assert.Equal(100, fill.GetProperty("outcomeFaceAmountSats").GetInt32());
        Assert.Equal(45, fill.GetProperty("quotePaymentSats").GetInt32());
        Assert.Equal(makerOutcomeSetId, fill.GetProperty("sellerKeepOutcomeSetId").GetString());
        Assert.Equal(takerOutcomeSetId, fill.GetProperty("sellerLockOutcomeSetId").GetString());
        Assert.Equal(0, takerEngine.GetProperty("remainingAmountSats").GetInt32());

        using var makerTrade = await WaitForTradeRecordAsync(
            maker,
            tradeId!,
            record => HasMintMetadata(
                record,
                takerMarketId,
                expectedRole: "seller",
                sellerKeepOutcomeSetId: makerOutcomeSetId,
                sellerLockOutcomeSetId: takerOutcomeSetId,
                outcomeFaceAmountSats: 100,
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
                outcomeFaceAmountSats: 100,
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
        var conditionId = NewConditionId();
        const string makerOutcomeSetId = "Alice|Bob";
        const string takerOutcomeSetId = "Alice";
        var makerMarketId = $"{conditionId}-{makerOutcomeSetId}";
        var takerMarketId = $"{conditionId}-{takerOutcomeSetId}";

        using var makerSubmit = await RunCliJsonAsync(maker, [
            "order",
            "submit",
            makerMarketId,
            makerOutcomeSetId,
            "Buy",
            "60",
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
        Assert.Equal(100, takerEngine.GetProperty("remainingAmountSats").GetInt32());

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
        Assert.Equal(100, makerEngine.GetProperty("remainingAmountSats").GetInt32());
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
    public async Task ComplementaryBuySettlement_Matrix_PersistsLocalOutcomeProofs(
        TradingClientKind makerKind,
        TradingClientKind takerKind,
        bool makerPreflightSplit)
    {
        var condition = await FindBinaryConditionAsync();
        var makerOutcomeSetId = condition.YesOutcomeSetId;
        var takerOutcomeSetId = condition.NoOutcomeSetId;
        var makerMarketId = $"{condition.ConditionId}-{makerOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{takerOutcomeSetId}";
        const int faceAmountSats = 100;
        const int makerFundingSats = 210;
        const int makerPrice = 1;
        const int takerPrice = 99;

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
            await taker.FundSatsAsync(faceAmountSats);

            var makerOrderId = await maker.SubmitRestingComplementaryMakerBuyAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                makerMarketId,
                makerPrice,
                faceAmountSats,
                makerPreflightSplit);
            await WaitForEngineBidAsync(makerMarketId, faceAmountSats);
            if (makerPreflightSplit)
            {
                await maker.AssertReservedOutcomeProofsAsync(
                    condition.ConditionId,
                    makerOutcomeSetId,
                    faceAmountSats);
                await maker.AssertReservedOutcomeProofsAsync(
                    condition.ConditionId,
                    takerOutcomeSetId,
                    faceAmountSats);
            }

            var tradeId = await taker.SubmitComplementaryTakerBuyAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                takerMarketId,
                takerPrice,
                faceAmountSats);

            await maker.RefreshMatchedOrderAsync(makerMarketId, makerOrderId, tradeId);
            await maker.WaitConfirmedAsync(tradeId);
            await taker.WaitConfirmedAsync(tradeId);

            await maker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                faceAmountSats);
            await taker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                faceAmountSats);
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
        var condition = await FindCategoricalConditionAsync();
        var takerOutcomeSetId = condition.PrimitiveOutcomeSetIds[0];
        var makerOutcomeSetId = CanonicalOutcomeSet(condition.PrimitiveOutcomeSetIds.Skip(1));
        var makerMarketId = $"{condition.ConditionId}-{makerOutcomeSetId}";
        var takerMarketId = $"{condition.ConditionId}-{takerOutcomeSetId}";
        const int faceAmountSats = 100;
        const int makerFundingSats = 210;
        const int makerPrice = 1;
        const int takerPrice = 99;

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
            await taker.FundSatsAsync(faceAmountSats);

            var makerOrderId = await maker.SubmitRestingComplementaryMakerBuyAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                makerMarketId,
                makerPrice,
                faceAmountSats,
                preflightSplit: true,
                displayedOutcomeSetId: takerOutcomeSetId);
            await WaitForEngineBidAsync(makerMarketId, faceAmountSats);

            await maker.AssertReservedOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                faceAmountSats);
            await maker.AssertReservedOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                faceAmountSats);

            var tradeId = await taker.SubmitComplementaryTakerBuyAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                takerMarketId,
                takerPrice,
                faceAmountSats);

            try
            {
                await maker.RefreshMatchedOrderAsync(makerMarketId, makerOrderId, tradeId);
                await taker.WaitConfirmedAsync(tradeId);
            }
            catch (Exception ex)
            {
                throw await maker.BuildDiagnosticExceptionAsync(
                    $"Mint complementary settlement did not confirm for trade {tradeId}. Inner={ex.Message}");
            }

            await maker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                makerOutcomeSetId,
                faceAmountSats);
            await taker.AssertAvailableOutcomeProofsAsync(
                condition.ConditionId,
                takerOutcomeSetId,
                faceAmountSats);
        }
        finally
        {
            if (browser is not null) await browser.CloseAsync();
            playwright.Dispose();
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
        const int faceAmountSats = 100;
        const int quoteAmountSats = 50;

        var makerSatToken = await MintTokenAsync("sats", faceAmountSats);
        using var makerReceive = await RunCliJsonAsync(maker, [
            "wallet",
            "receive",
            makerSatToken,
        ]);
        Assert.True(makerReceive.RootElement.GetProperty("ok").GetBoolean());

        var takerSatToken = await MintTokenAsync("sats", quoteAmountSats);
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
            faceAmountSats.ToString(),
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
            faceAmountSats.ToString(),
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
        const int faceAmountSats = 100;
        const int quoteAmountSats = 50;

        var makerSatToken = await MintTokenAsync("sats", faceAmountSats);
        using var makerReceive = await RunCliJsonAsync(maker, [
            "wallet",
            "receive",
            makerSatToken,
        ]);
        Assert.True(makerReceive.RootElement.GetProperty("ok").GetBoolean());

        var takerSatToken = await MintTokenAsync("sats", quoteAmountSats);
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
            faceAmountSats.ToString(),
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
            faceAmountSats.ToString(),
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
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            amountSats,
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
        var condition = await FindBinaryConditionAsync();
        var tradingOutcomeSetId = condition.YesOutcomeSetId;
        var marketId = $"{condition.ConditionId}-{tradingOutcomeSetId}";
        const int amountSats = 100;
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            amountSats,
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
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            amountSats,
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
        const string price = "50";

        var sellerOutcomeToken = await MintTokenAsync(
            "outcome",
            amountSats,
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

                await RestartDaemonAsync(seller);

                await WaitForTradeStepAsync(seller, tradeId, "confirmed");
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
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            amountSats,
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
                    sellerConsole);
                await WaitForEngineAskAsync(marketId, amountSats);

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

                await WaitForBrowserOutcomeProofsAsync(
                    buyerPage,
                    condition.ConditionId,
                    tradingOutcomeSetId,
                    buyerConsole);
                await WaitForBrowserBaseProofsAsync(
                    sellerPage,
                    amountSats * price / 100,
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
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            amountSats,
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
                    amountSats * price / 100,
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
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            amountSats,
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
                    amountSats * price / 100,
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
        const int price = 50;
        var sellerOutcomeProofs = await MintProofsJsonAsync(
            "outcome",
            amountSats,
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
                    amountSats * price / 100,
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
        await context.AddInitScriptAsync("""
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
                      if (text.includes('TradeCreated') || text.includes('"error"') || text.includes('"type":3')) {
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
        var page = await context.NewPageAsync();
        var consoleMessages = TestHelpers.AttachConsoleCapture(page);
        await SetupBrowserWalletAndSignerAsync(page, browserNsec);
        return new GuiTradingClient(page, consoleMessages);
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
            var args = new List<string>
            {
                "order",
                "submit",
                marketId,
                outcomeSetId,
                "Buy",
                price.ToString(),
                amountSats.ToString(),
                "GTC",
            };
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

        public Task WaitConfirmedAsync(string tradeId) => Task.CompletedTask;

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

    private async Task WaitForTradeStepAsync(
        DaemonHandle daemon,
        string tradeId,
        string expectedStep)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
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
                    if (string.Equals(lastStep, "failed", StringComparison.OrdinalIgnoreCase))
                        break;
                }
            }
            await Task.Delay(500);
        }

        throw new TimeoutException(
            $"Trade {tradeId} did not reach {expectedStep}. " +
            $"Last step={lastStep ?? "(none)"}, error={lastError ?? "(none)"}");
    }

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

        var limitOrder = page.GetByRole(AriaRole.Button, new() { Name = "Limit" })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = page.GetByRole(
                AriaRole.Button,
                new() { NameRegex = new Regex($"^{Regex.Escape(outcomeSetId)}\\s", RegexOptions.IgnoreCase) })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = page.GetByTestId("trade-amount-input")
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync(amountSats.ToString());

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

        var confirm = page.GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;
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
            var status = await page.GetByTestId("trade-submit-status")
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
        IReadOnlyList<string> consoleMessages)
    {
        await page.GotoAsync($"{TestPorts.FrontendUrl}/markets/{conditionId}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 30_000,
        });

        var sellToggle = page.GetByRole(AriaRole.Button, new() { Name = "Sell", Exact = true })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(sellToggle).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await sellToggle.ClickAsync();

        var limitOrder = page.GetByRole(AriaRole.Button, new() { Name = "Limit" })
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(limitOrder).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await limitOrder.ClickAsync();

        var outcomeButton = TradeOutcomeButton(page, outcomeSetId);
        await Assertions.Expect(outcomeButton).ToBeVisibleAsync(new() { Timeout = 10_000 });
        await outcomeButton.ClickAsync();

        var amountInput = page.GetByTestId("trade-amount-input")
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync(amountSats.ToString());

        var priceInput = page.Locator("input[type='number']")
            .Filter(new() { Visible = true })
            .Nth(1);
        await Assertions.Expect(priceInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await priceInput.FillAsync(limitPrice.ToString());

        var confirm = page.GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;
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
            var status = await page.GetByTestId("trade-submit-status")
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

        var limitOrder = page.GetByRole(AriaRole.Button, new() { Name = "Limit" })
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

        var amountInput = page.GetByTestId("trade-amount-input")
            .Filter(new() { Visible = true })
            .First;
        await Assertions.Expect(amountInput).ToBeVisibleAsync(new() { Timeout = 5_000 });
        await amountInput.FillAsync(amountSats.ToString());

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

        var confirm = page.GetByTestId("trade-confirm")
            .Filter(new() { Visible = true })
            .First;
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
            var status = await page.GetByTestId("trade-submit-status")
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

        await WaitForSignalRInvocationAsync(consoleMessages, "JoinOrder", orderId!);
        return orderId!;
    }

    private static async Task WaitForSignalRInvocationAsync(
        IReadOnlyList<string> consoleMessages,
        string target,
        string expectedFragment)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline)
        {
            if (consoleMessages.Any(message =>
                    message.Contains($"[e2e-signalr-send] {target}", StringComparison.Ordinal)
                    && message.Contains(expectedFragment, StringComparison.OrdinalIgnoreCase)))
            {
                return;
            }
            await Task.Delay(100);
        }

        throw new TimeoutException(
            $"Browser did not invoke SignalR {target} containing {expectedFragment} before the match.");
    }

    private static ILocator TradeOutcomeButton(IPage page, string outcomeSetId, bool complement = false)
    {
        if (string.Equals(outcomeSetId, "yes", StringComparison.OrdinalIgnoreCase))
        {
            return page.GetByTestId("trade-outcome-yes")
                .Filter(new() { Visible = true })
                .First;
        }

        if (string.Equals(outcomeSetId, "no", StringComparison.OrdinalIgnoreCase))
        {
            return page.GetByTestId("trade-outcome-no")
                .Filter(new() { Visible = true })
                .First;
        }

        var outcomeLabel = XPathLiteral(outcomeSetId);
        var buttonLabel = XPathLiteral(complement ? "Buy NO" : "Buy YES");
        return page.Locator(
                $"xpath=//*[normalize-space(.)={outcomeLabel}]/ancestor::*[.//button[normalize-space(.)={buttonLabel}]][1]//button[normalize-space(.)={buttonLabel}]")
            .Filter(new() { Visible = true })
            .First;
    }

    private static string XPathLiteral(string value)
    {
        if (!value.Contains('\''))
        {
            return $"'{value}'";
        }

        if (!value.Contains('"'))
        {
            return $"\"{value}\"";
        }

        return $"concat({string.Join(", \"'\", ", value.Split('\'').Select(part => $"'{part}'"))})";
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

        var outcomeCollections = PrimitiveOutcomeCollections(outcomeSetId);
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
            $"Browser did not persist local outcome proofs for {conditionId}-{outcomeSetId}. availableOnly={availableOnly}, reservedOnly={reservedOnly}, expected each primitive >= {minimumSats}, last sums={JsonSerializer.Serialize(lastSums)}.");
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
        var outcomeCollections = PrimitiveOutcomeCollections(outcomeSetId);
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
            $"Expected each primitive >= {minimumSats}, lastAmounts={JsonSerializer.Serialize(lastAmounts)}, last={lastBody ?? "(none)"}");
    }

    private static string[] PrimitiveOutcomeCollections(string outcomeSetId) =>
        outcomeSetId
            .Split('|', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .ToArray();

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
        int outcomeFaceAmountSats,
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
               && record.TryGetProperty("outcomeFaceAmountSats", out var face)
               && face.GetInt32() == outcomeFaceAmountSats
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
            if (!condition.TryGetProperty("partitions", out var partitions)
                || partitions.ValueKind != JsonValueKind.Array)
                continue;
            foreach (var partition in partitions.EnumerateArray())
            {
                if (!partition.TryGetProperty("partition", out var outcomes)
                    || outcomes.ValueKind != JsonValueKind.Array)
                    continue;
                var outcome = outcomes.EnumerateArray()
                    .Select(item => item.GetString())
                    .FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));
                if (!string.IsNullOrWhiteSpace(outcome))
                    return (conditionId, outcome);
            }
        }

        throw new InvalidOperationException("No fundable CTF condition/outcome was available from the mint.");
    }

    private static async Task<(string ConditionId, string YesOutcomeSetId, string NoOutcomeSetId)> FindBinaryConditionAsync()
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
            if (!condition.TryGetProperty("partitions", out var partitions)
                || partitions.ValueKind != JsonValueKind.Array)
                continue;
            foreach (var partition in partitions.EnumerateArray())
            {
                if (!partition.TryGetProperty("partition", out var outcomes)
                    || outcomes.ValueKind != JsonValueKind.Array)
                    continue;
                var values = outcomes.EnumerateArray()
                    .Select(item => item.GetString())
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .Select(value => value!)
                    .ToArray();
                var yes = values.FirstOrDefault(value => string.Equals(value, "YES", StringComparison.OrdinalIgnoreCase));
                var no = values.FirstOrDefault(value => string.Equals(value, "NO", StringComparison.OrdinalIgnoreCase));
                if (yes is not null && no is not null)
                    return (conditionId, yes, no);
            }
        }

        throw new InvalidOperationException("No binary YES/NO CTF condition was available from the mint.");
    }

    private static async Task<(string ConditionId, string[] PrimitiveOutcomeSetIds)> FindCategoricalConditionAsync()
    {
        using var httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
        var tradableConditionIds = await LoadTradableMarketConditionIdsAsync(httpClient);
        using var response = await httpClient.GetAsync($"{TestPorts.MintUrl}/v1/conditions");
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync();
        using var doc = await JsonDocument.ParseAsync(stream);
        (string ConditionId, string[] PrimitiveOutcomeSetIds)? fallback = null;
        foreach (var condition in doc.RootElement.GetProperty("conditions").EnumerateArray())
        {
            var conditionId = condition.GetProperty("condition_id").GetString();
            if (string.IsNullOrWhiteSpace(conditionId) || conditionId.Length != 64)
                continue;
            if (!condition.TryGetProperty("partitions", out var partitions)
                || partitions.ValueKind != JsonValueKind.Array)
                continue;
            foreach (var partition in partitions.EnumerateArray())
            {
                if (!partition.TryGetProperty("partition", out var outcomes)
                    || outcomes.ValueKind != JsonValueKind.Array)
                    continue;
                var values = outcomes.EnumerateArray()
                    .Select(item => item.GetString())
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .Select(value => value!)
                    .ToArray();
                if (values.Length >= 3)
                {
                    if (tradableConditionIds.Contains(conditionId))
                        return (conditionId, values);
                    fallback ??= (conditionId, values);
                }
            }
        }

        if (fallback is not null)
            return fallback.Value;

        throw new InvalidOperationException("No categorical CTF condition with at least three outcomes was available from the mint.");
    }

    private static async Task<HashSet<string>> LoadTradableMarketConditionIdsAsync(HttpClient httpClient)
    {
        try
        {
            using var response = await httpClient.GetAsync($"{TestPorts.ServerUrl}/api/v1/markets/query?state=All&limit=100");
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

    private async Task<ProcessResult> RunNodeAsync(
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
            if (result.ExitCode != 0)
                throw new InvalidOperationException(
                    $"node {Path.GetFileName(script)} exited {result.ExitCode}\n" +
                    $"stdout:\n{result.Stdout}\nstderr:\n{result.Stderr}");
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

    private sealed record ProcessResult(int ExitCode, string Stdout, string Stderr);

    private sealed record DaemonHandle(string Home, int Port)
    {
        public Process? Process { get; set; }
    }
}
