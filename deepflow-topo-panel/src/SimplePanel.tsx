import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { DataSourceInstanceSettings, PanelProps } from '@grafana/data'
import { SimpleOptions } from 'types'
import './SimplePanel.css'
import _ from 'lodash'
import { Select, Alert } from '@grafana/ui'
import { getDataSourceSrv } from '@grafana/runtime'
import { addSvg, fitSvgToContainer, renderSimpleTreeTopoChart, simpleTopoRender, Node, Link } from 'deepflow-vis-js'
import { TopoTooltip } from 'components/TopoTooltip'

type NodeItem = {
  id: string
  node_type: string
  displayName: string
  tags: Record<any, any>
} & Record<any, any>

type LinkItem = {
  from: string
  to: string
  metrics: any[]
  metricValue: number
} & Record<any, any>

interface Props extends PanelProps<SimpleOptions> {}

//  ip: 255, internet_ip: 0
const IP_LIKELY_NODE_TYPE_TDS = [255, 0]

export const SimplePanel: React.FC<Props> = ({ options, data, width, height }) => {
  const [errMsg, setErrMsg] = useState('')
  const [chartContainer, setChartContainer] = useState<any>(undefined)
  const [targetIndex, setTargetIndex] = useState(0)
  const [noData, setNoData] = useState(false)

  const [tooltipContent, setTooltipContent] = useState({})
  const [mousePos, setMousePos] = useState({
    x: 0,
    y: 0
  })

  const { series, request } = data
  const refIds = useMemo(() => {
    return request?.targets
      ? request.targets.map((target, index) => {
          return {
            value: index,
            label: target.refId
          }
        })
      : []
  }, [request])
  const isMultiRefIds = refIds.length > 1
  const selectedData = useMemo(() => {
    if (series[targetIndex]?.fields === undefined || !series[targetIndex]?.fields?.length) {
      setNoData(true)
      if (chartContainer) {
        chartContainer.selectAll('*').remove()
      }
    } else {
      setNoData(false)
    }
    setTooltipContent({})
    return series[targetIndex]
  }, [series, targetIndex, chartContainer])

  const [queryConfig, setQueryConfig] = useState<
    { returnMetrics: any[]; returnTags: any[]; from: string[]; to: string[]; common: string[] } | undefined
  >(undefined)
  const getConfigByRefId = useCallback(async () => {
    const deepFlowName = await getDataSourceSrv()
      .getList()
      .find((dataSource: DataSourceInstanceSettings) => {
        return dataSource.type === 'deepflow-querier-datasource'
      })?.name
    const deepFlow = await getDataSourceSrv().get(deepFlowName)
    const refId = refIds[targetIndex].label
    const result = deepFlow
      ? // @ts-ignore
        (deepFlow.getQueryConfig(refId) as {
          returnMetrics: any[]
          returnTags: any[]
          from: string[]
          to: string[]
          common: string[]
        })
      : undefined
    setQueryConfig(result)
  }, [refIds, targetIndex])
  useEffect(() => {
    getConfigByRefId()
  }, [getConfigByRefId, selectedData])

  const sourceSide = useMemo(() => {
    if (!queryConfig?.from?.length) {
      return []
    }
    return queryConfig.from
  }, [queryConfig])
  const destinationSide = useMemo(() => {
    if (!queryConfig?.to?.length) {
      return []
    }
    return queryConfig.to
  }, [queryConfig])

  const links: LinkItem[] = useMemo(() => {
    if (!selectedData?.fields?.length || !sourceSide.length || !destinationSide.length || !queryConfig?.returnMetrics) {
      return []
    }
    const filedNames = selectedData.fields.map(field => field.name)
    const dataIsMatched = [...sourceSide, ...destinationSide, ...queryConfig.common].every(e => {
      return filedNames.includes(e)
    })
    if (!dataIsMatched) {
      return []
    }
    const fullData: any[] = []
    selectedData.fields.forEach((e: any, i: number) => {
      e.values.toArray().forEach((val: any, index: number) => {
        if (!fullData[index]) {
          fullData[index] = {}
        }
        fullData[index][e.name] = val
      })
    })
    const result: LinkItem[] = fullData.map(e => {
      return {
        ...e,
        from:
          [...sourceSide, ...queryConfig.common]
            .map(key => {
              if (key.includes('resource_gl')) {
                const nodeTypeId = e[key.replace('_id', '_type')]
                if (IP_LIKELY_NODE_TYPE_TDS.includes(nodeTypeId)) {
                  return `${e['ip_0']}${e['subnet_id_0']}`
                }
              }
              return e[key]
            })
            .join(' ') + ` ${e.client_node_type}`,
        to:
          [...destinationSide, ...queryConfig.common]
            .map(key => {
              if (key.includes('resource_gl')) {
                const nodeTypeId = e[key.replace('_id', '_type')]
                if (IP_LIKELY_NODE_TYPE_TDS.includes(nodeTypeId)) {
                  return `${e['ip_1']}${e['subnet_id_1']}`
                }
              }
              return e[key]
            })
            .join(' ') + ` ${e.server_node_type}`,
        metrics: Object.fromEntries(
          queryConfig.returnMetrics.map(metric => {
            const key = metric.name
            return [[key], e[key]]
          })
        ),
        metricValue: _.get(e, [_.get(queryConfig, ['returnMetrics', 0, 'name'])])
      }
    })
    return result
  }, [selectedData, sourceSide, destinationSide, queryConfig])

  const nodes: NodeItem[] = useMemo(() => {
    if (!links?.length || !queryConfig?.from?.length || !queryConfig?.to?.length) {
      return []
    }
    const result: any[] = links
      .map(e => {
        return [
          {
            id: e['from'],
            node_type: e['client_node_type'],
            displayName: _.get(e, ['client_resource']),
            tags: {
              node_type: e['client_node_type'],
              ...Object.fromEntries(
                [...queryConfig.from, ...queryConfig.common].map(tag => {
                  return [[tag], e[tag]]
                })
              )
            }
          },
          {
            id: e['to'],
            node_type: e['server_node_type'],
            displayName: _.get(e, ['server_resource']),
            tags: {
              node_type: e['server_node_type'],
              ...Object.fromEntries(
                [...queryConfig.to, ...queryConfig.common].map(tag => {
                  return [[tag], e[tag]]
                })
              )
            }
          }
        ]
      })
      .flat(Infinity)
    return _.uniqBy(result, 'id')
  }, [links, queryConfig])

  const panelRef = useRef(null)
  const [randomClassName, setRandomClassName] = useState('')
  useEffect(() => {
    const randomString = 'chart' + Math.random().toFixed(9).replace('0.', '')
    setRandomClassName(randomString)
  }, [panelRef])

  useEffect(() => {
    if (!randomClassName) {
      return
    }
    const container = addSvg('.' + randomClassName)
    fitSvgToContainer(container)
    setChartContainer(container)
  }, [randomClassName])

  const bodyClassName = document.body.className
  const isDark = useMemo(() => {
    return bodyClassName.includes('theme-dark')
  }, [bodyClassName])

  useEffect(() => {
    if (!chartContainer || !nodes.length || !links.length) {
      return
    }
    try {
      const titleColor = isDark ? '#bbb' : '#333'
      const nodeAndLinkColor = isDark ? '#206FD6' : '#B6BFD1'
      chartContainer.selectAll('*').remove()
      const { nodes: _nodes, links: _links } = renderSimpleTreeTopoChart(
        chartContainer,
        {
          nodes,
          links
        },
        {
          getNodeV: (node: Node<NodeItem>) => 0,
          getNodeColor: (node: Node<NodeItem>) => nodeAndLinkColor,
          getNodeIcon: (node: Node<NodeItem>) => {
            return node.data.node_type.includes('ip') ? 'ip' : node.data.node_type
          },
          getNodeTitle: (node: Node<NodeItem>) => node.data.displayName,
          getLinkV: (link: Link<LinkItem>) => link.data.metricValue,
          getLinkColor: (link: Link<LinkItem>) => nodeAndLinkColor,
          titleColor: titleColor,
          nodeSize: [40, 40]
        }
      )
      _links.forEach((link: Link<LinkItem>) => {
        simpleTopoRender.bindCustomMouseEvent(link, 'mouseenter', (e: MouseEvent, l: Link<LinkItem>) => {
          const metricsObj = _.get(l.data, ['metrics'], {})
          setTooltipContent(metricsObj)
        })
        simpleTopoRender.bindCustomMouseEvent(link, 'mousemove', (e: MouseEvent, l: Link<LinkItem>) => {
          setTimeout(() => {
            setMousePos({
              x: e.clientX,
              y: e.clientY
            })
          })
        })
        simpleTopoRender.bindCustomMouseEvent(link, 'mouseleave', (e: MouseEvent, l: Link<LinkItem>) => {
          setTooltipContent({})
        })
      })
      _nodes.forEach((node: Node<NodeItem>) => {
        simpleTopoRender.bindCustomMouseEvent(node, 'mouseenter', (e: MouseEvent, n: Node<NodeItem>) => {
          const tagsObj = _.get(n.data, ['tags'], {})
          setTooltipContent(tagsObj)
        })
        simpleTopoRender.bindCustomMouseEvent(node, 'mousemove', (e: MouseEvent, n: Node<NodeItem>) => {
          setTimeout(() => {
            setMousePos({
              x: e.clientX,
              y: e.clientY
            })
          })
        })
        simpleTopoRender.bindCustomMouseEvent(node, 'mouseleave', (e: MouseEvent, n: Node<NodeItem>) => {
          setTooltipContent({})
        })
      })
    } catch (error: any) {
      console.log(error)
      setErrMsg(error.toString() || 'draw topo failed')
    }
  }, [nodes, links, chartContainer, isDark])

  return (
    <div ref={panelRef} className="topo-actions-wrap">
      <div className="actions-warp">
        {isMultiRefIds ? (
          <Select
            className={'ref-select'}
            options={refIds}
            value={targetIndex}
            onChange={v => {
              setTargetIndex(v.value as number)
            }}
          ></Select>
        ) : null}
      </div>
      {noData ? <div>No Data</div> : null}
      <div className={`chart-container ${randomClassName}`}></div>
      <TopoTooltip contentData={tooltipContent} mousePos={mousePos}></TopoTooltip>
      {errMsg ? (
        <Alert
          title={errMsg}
          style={{
            position: 'fixed',
            top: '15px',
            right: '15px',
            zIndex: 9999
          }}
          severity="error"
          onRemove={() => setErrMsg('')}
        ></Alert>
      ) : null}
    </div>
  )
}
