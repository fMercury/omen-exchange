import { useEffect, useState } from 'react'

import { ConnectedWeb3Context } from './connectedWeb3'
import { useContracts, Contracts } from './useContracts'
import { EARLIEST_BLOCK_TO_CHECK, FETCH_EVENTS_CHUNK_SIZE } from '../common/constants'
import { MarketWithExtraData, MarketFilters } from '../util/types'
import { callInChunks, Range } from '../util/call_in_chunks'
import { RemoteData } from '../util/remote_data'

const fetchMarkets = async (
  account: Maybe<string>,
  filter: MarketFilters,
  range: Range,
  expectedMarketsCount: number,
  contracts: Contracts,
): Promise<{ markets: MarketWithExtraData[]; usedRange: Range }> => {
  const { conditionalTokens, marketMakerFactory, realitio, buildMarketMaker } = contracts

  const fetchAndFilter = async (subrange: Range): Promise<MarketWithExtraData[]> => {
    const validMarkets = await marketMakerFactory.getMarketsWithExtraData(
      {
        from: subrange[0],
        to: subrange[1],
      },
      conditionalTokens,
      realitio,
    )

    let filteredMarkets = validMarkets
    if (account) {
      if (filter === MarketFilters.MyMarkets) {
        filteredMarkets = validMarkets.filter(market => market.ownerAddress === account)
      } else if (filter === MarketFilters.FundedMarkets) {
        filteredMarkets = []
        for (const market of validMarkets) {
          const marketMakerService = buildMarketMaker(market.address)
          const poolShares = await marketMakerService.poolSharesBalanceOf(account)
          if (poolShares.gt(0)) {
            filteredMarkets.push(market)
          }
        }
      }
    }

    return filteredMarkets
  }

  const [marketsPage, usedRange] = await callInChunks(fetchAndFilter, range, {
    callUntil: result => result.length >= expectedMarketsCount,
    chunkSize: FETCH_EVENTS_CHUNK_SIZE,
    delay: 100,
  })

  const marketsOrdered = marketsPage.sort(
    (marketA: MarketWithExtraData, marketB: MarketWithExtraData) => {
      if (marketA.resolution && marketB.resolution) {
        return marketB.resolution.getTime() - marketA.resolution.getTime()
      }
      return 0
    },
  )

  return { markets: marketsOrdered, usedRange }
}

export const useMarkets = (
  context: ConnectedWeb3Context,
  filter: MarketFilters,
  expectedMarketsCount: number,
): {
  markets: RemoteData<MarketWithExtraData[]>
  moreMarkets: boolean
} => {
  const contracts = useContracts(context)

  const [markets, setMarkets] = useState<RemoteData<MarketWithExtraData[]>>(RemoteData.loading())
  const [latestBlockToCheck, setLatestBlockTocheck] = useState<Maybe<number>>(null)
  const [moreMarkets, setMoreMarkets] = useState(true)
  const [needFetchMore, setNeedFetchMore] = useState(true)

  useEffect(() => {
    setMoreMarkets(latestBlockToCheck === null || latestBlockToCheck > EARLIEST_BLOCK_TO_CHECK)
  }, [latestBlockToCheck])

  // Set `needFetchMore` to true when it makes sense to fetch more markets
  useEffect(() => {
    if (
      RemoteData.is.success(markets) &&
      markets.data.length < expectedMarketsCount &&
      moreMarkets
    ) {
      setNeedFetchMore(true)
    }
  }, [markets, moreMarkets, expectedMarketsCount])

  // restart values when the filter changes
  useEffect(() => {
    const run = async () => {
      const blockNumber = await context.library.getBlockNumber()
      setMarkets(RemoteData.notAsked())
      setLatestBlockTocheck(blockNumber)
      setNeedFetchMore(true)
    }
    run()
  }, [context, filter])

  // fetch markets
  useEffect(() => {
    let didCancel = false

    const run = async (range: Range) => {
      try {
        setMarkets(markets =>
          RemoteData.hasData(markets) ? RemoteData.reloading(markets.data) : RemoteData.loading(),
        )
        const result = await fetchMarkets(
          context.account,
          filter,
          range,
          expectedMarketsCount,
          contracts,
        )

        if (!didCancel) {
          setNeedFetchMore(false)
          setLatestBlockTocheck(result.usedRange[0] - 1)
          setMarkets(currentMarkets =>
            RemoteData.hasData(currentMarkets)
              ? RemoteData.success(currentMarkets.data.concat(result.markets))
              : RemoteData.success(result.markets),
          )
        }
      } catch (e) {
        if (!didCancel) {
          setMarkets(RemoteData.failure(e))
        }
      }
    }

    if (latestBlockToCheck && needFetchMore) {
      run([EARLIEST_BLOCK_TO_CHECK, latestBlockToCheck])
    }

    return () => {
      didCancel = true
    }
  }, [context, filter, latestBlockToCheck, expectedMarketsCount, needFetchMore, contracts])

  return {
    markets,
    moreMarkets,
  }
}
