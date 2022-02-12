import { AUTO, autoTimeIntervals } from '../constants'

/** getWindowAndResolution
 *
 * @param autoWinResConfig is an array of Object with length always greater than 1,
 * i.e config array should contain at least 1 object
 * @param timeRange
 * @returns {{window, resolution}}
 */
export const getWindowAndResolution = (autoWinResConfig:any, timeRange:any) => {
  let i = -1
  do { i++ } while (i < autoWinResConfig.length - 1 && timeRange > autoWinResConfig[i][0])
  const { window, resolution } = autoWinResConfig[i][1]
  return { window, resolution }
}

/** resolveAutoWinRes
 *
 * @param windowSelected
 * @param resolutionSelected
 * @param timeRangeSelected
 * @returns {{window: *, resolution: *}}
 */
export const resolveAutoWinRes = (windowSelected:any, resolutionSelected:any, timeRangeSelected:any) => {
  const result = { window: windowSelected, resolution: resolutionSelected }
  if (windowSelected !== AUTO && resolutionSelected !== AUTO) return result
  const { window, resolution } = getWindowAndResolution(autoTimeIntervals, timeRangeSelected)
  if (windowSelected === AUTO) result.window = window
  if (resolutionSelected === AUTO) result.resolution = resolution
  return result
}

export const removeQuotes = (str: string) => {
  if (!str) {
    return str;
  }

  let res = str;
  if (str.startsWith("'") || str.startsWith('"')) {
    res = res.slice(1);
  }
  if (str.endsWith("'") || str.endsWith('"')) {
    res = res.slice(0, res.length - 1);
  }
  return res;
};